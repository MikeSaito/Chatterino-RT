use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::cheers::CheerCatalog;
use super::emotes::Catalog;
use super::helix::BadgeCatalog;
use super::hub::Hub;
use super::irc::IrcCmd;

#[derive(Clone)]
pub struct Shared {
    pub hub: Arc<Mutex<Hub>>,
    pub catalog: Arc<Mutex<Catalog>>,
    pub badges: Arc<Mutex<BadgeCatalog>>,
    pub cheers: Arc<Mutex<CheerCatalog>>,
    pub irc_tx: Arc<Mutex<Option<mpsc::Sender<IrcCmd>>>>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            hub: Arc::new(Mutex::new(Hub::default())),
            catalog: Arc::new(Mutex::new(Catalog::default())),
            badges: Arc::new(Mutex::new(BadgeCatalog::default())),
            cheers: Arc::new(Mutex::new(CheerCatalog::default())),
            irc_tx: Arc::new(Mutex::new(None)),
        }
    }
}
