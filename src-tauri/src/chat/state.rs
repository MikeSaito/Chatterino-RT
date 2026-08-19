use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::emotes::Catalog;
use super::hub::Hub;
use super::irc::IrcCmd;

#[derive(Clone)]
pub struct Shared {
    pub hub: Arc<Mutex<Hub>>,
    pub catalog: Arc<Mutex<Catalog>>,
    pub irc_tx: Arc<Mutex<Option<mpsc::Sender<IrcCmd>>>>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            hub: Arc::new(Mutex::new(Hub::default())),
            catalog: Arc::new(Mutex::new(Catalog::default())),
            irc_tx: Arc::new(Mutex::new(None)),
        }
    }
}
