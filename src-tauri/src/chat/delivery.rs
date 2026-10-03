//! A queue receipt is completed only after a socket write. Cancellation and
//! starting a write share a lock, so a timed-out draft cannot be sent later.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use super::commands::ApiError;

#[derive(Debug, PartialEq, Eq)]
enum Phase {
    Queued,
    Writing,
    Finished,
    Cancelled,
}

#[derive(Debug)]
pub struct DeliveryTicket {
    phase: Arc<Mutex<Phase>>,
    tx: Option<oneshot::Sender<Result<(), ApiError>>>,
}

pub struct DeliveryReceipt {
    phase: Arc<Mutex<Phase>>,
    rx: oneshot::Receiver<Result<(), ApiError>>,
}

pub fn queued() -> (DeliveryTicket, DeliveryReceipt) {
    let phase = Arc::new(Mutex::new(Phase::Queued));
    let (tx, rx) = oneshot::channel();
    (
        DeliveryTicket {
            phase: phase.clone(),
            tx: Some(tx),
        },
        DeliveryReceipt { phase, rx },
    )
}

impl DeliveryTicket {
    pub fn start(&self) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        if *phase != Phase::Queued {
            return false;
        }
        *phase = Phase::Writing;
        true
    }

    pub fn cancelled(&self) -> bool {
        self.phase
            .lock()
            .map_or(true, |phase| *phase == Phase::Cancelled)
    }

    pub fn finish(&mut self, result: Result<(), ApiError>) {
        if let Ok(mut phase) = self.phase.lock() {
            *phase = Phase::Finished;
        }
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(result);
        }
    }
}

impl Drop for DeliveryTicket {
    fn drop(&mut self) {
        if self.tx.is_none() {
            return;
        }
        let writing = self
            .phase
            .lock()
            .is_ok_and(|phase| *phase == Phase::Writing);
        self.finish(Err(if writing {
            unknown()
        } else {
            ApiError::coded("error.message.send_cancelled", "Queued message cancelled")
        }));
    }
}

pub fn unknown() -> ApiError {
    ApiError::coded(
        "error.message.send_unknown",
        "Connection lost during sending. Delivery is unknown; check chat before sending again.",
    )
}

impl DeliveryReceipt {
    pub async fn wait(self) -> Result<(), ApiError> {
        self.wait_for(Duration::from_secs(30)).await
    }

    pub(super) async fn wait_for(mut self, duration: Duration) -> Result<(), ApiError> {
        match tokio::time::timeout(duration, &mut self.rx).await {
            Ok(result) => result.map_err(|_| unknown())?,
            Err(_) => {
                {
                    let mut phase = self.phase.lock().map_err(|_| unknown())?;
                    if *phase == Phase::Queued {
                        *phase = Phase::Cancelled;
                        return Err(ApiError::coded(
                            "error.message.send_timeout",
                            "Message expired in queue. Try again.",
                        ));
                    }
                }
                // A write has already started. Its own eight-second timeout
                // decides the outcome; never offer a retry while it is alive.
                self.rx.await.map_err(|_| unknown())?
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn receipt_waits_for_socket_and_completes() {
        let (mut ticket, receipt) = queued();
        assert!(ticket.start());
        ticket.finish(Ok(()));
        assert!(receipt.wait().await.is_ok());
    }

    #[tokio::test]
    async fn timeout_cancels_before_write_and_cannot_send_later() {
        let (ticket, receipt) = queued();
        assert_eq!(
            receipt.wait_for(Duration::ZERO).await.unwrap_err().code,
            "error.message.send_timeout"
        );
        assert!(ticket.cancelled());
        assert!(!ticket.start());
    }

    #[tokio::test]
    async fn dropping_queue_is_retryable_but_dropping_write_is_unknown() {
        let (ticket, receipt) = queued();
        drop(ticket);
        assert_eq!(
            receipt.wait().await.unwrap_err().code,
            "error.message.send_cancelled"
        );
        let (ticket, receipt) = queued();
        assert!(ticket.start());
        drop(ticket);
        assert_eq!(
            receipt.wait().await.unwrap_err().code,
            "error.message.send_unknown"
        );
    }

    #[tokio::test]
    async fn timeout_during_write_still_waits_for_its_result() {
        let (mut ticket, receipt) = queued();
        assert!(ticket.start());
        let task = tokio::spawn(receipt.wait_for(Duration::ZERO));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!task.is_finished());
        ticket.finish(Ok(()));
        assert!(task.await.unwrap().is_ok());
    }
}
