use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use std::{io, thread};

use darktriad_core::{ChangeBatch, FolderWatcher, is_hidden};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// Quanto tempo o observador junta eventos antes de avisar: um build com mil arquivos vira
/// poucos lotes, e a árvore ainda atualiza bem antes de 1 s.
const BATCH_WINDOW: Duration = Duration::from_millis(200);

type EventResult = notify::Result<Event>;

/// Observa a pasta aberta com `notify` e entrega as mudanças em lotes, numa thread própria.
pub struct NotifyWatcher {
    events: Sender<EventResult>,
    current: Mutex<Option<RecommendedWatcher>>,
}

impl NotifyWatcher {
    pub fn new(on_batch: impl Fn(ChangeBatch) + Send + 'static) -> Self {
        let (events, receiver) = mpsc::channel();
        thread::spawn(move || {
            while let Some(batch) = next_batch(&receiver, BATCH_WINDOW) {
                if batch.rescan || !batch.paths.is_empty() {
                    on_batch(batch);
                }
            }
        });
        Self {
            events,
            current: Mutex::new(None),
        }
    }

    fn current(&self) -> MutexGuard<'_, Option<RecommendedWatcher>> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl FolderWatcher for NotifyWatcher {
    fn watch(&self, root: &Path) -> io::Result<()> {
        let mut current = self.current();
        *current = None;
        // Não segue links simbólicos, para não cair em ciclos.
        let config = Config::default().with_follow_symlinks(false);
        let mut watcher =
            RecommendedWatcher::new(self.events.clone(), config).map_err(io::Error::other)?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(io::Error::other)?;
        *current = Some(watcher);
        Ok(())
    }

    fn unwatch(&self) {
        *self.current() = None;
    }
}

/// Espera o primeiro evento e junta o que chegar até o fim da janela; `None` quando o canal fecha.
/// Descarta acessos (ler um arquivo não é mudança, e reler após cada aviso viraria um laço)
/// e tudo dentro dos itens escondidos, como `.git`.
fn next_batch(receiver: &Receiver<EventResult>, window: Duration) -> Option<ChangeBatch> {
    let first = receiver.recv().ok()?;
    let deadline = Instant::now() + window;
    let mut paths = BTreeSet::new();
    let mut rescan = false;
    let mut add = |result: EventResult| match result {
        Ok(event) => {
            rescan |= event.need_rescan();
            if !matches!(event.kind, EventKind::Access(_)) {
                paths.extend(event.paths.into_iter().filter(|path| !is_hidden(path)));
            }
        }
        Err(_) => rescan = true,
    };

    add(first);
    while let Ok(result) = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        add(result);
    }
    Some(ChangeBatch {
        paths: paths.into_iter().collect(),
        rescan,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use notify::event::{AccessKind, CreateKind, Flag, ModifyKind, RemoveKind};

    use super::*;
    use crate::test_support::TempDir;

    fn event(kind: EventKind, path: &str) -> EventResult {
        Ok(Event::new(kind).add_path(PathBuf::from(path)))
    }

    #[test]
    fn batch_merges_repeated_paths_and_drops_access_and_hidden_items() {
        let (sender, receiver) = mpsc::channel();
        for item in [
            event(EventKind::Create(CreateKind::File), "proj/novo.cpp"),
            event(EventKind::Modify(ModifyKind::Any), "proj/novo.cpp"),
            event(EventKind::Remove(RemoveKind::File), "proj/main.cpp"),
            event(EventKind::Access(AccessKind::Any), "proj/lido.cpp"),
            event(EventKind::Modify(ModifyKind::Any), "proj/.git/index"),
        ] {
            sender.send(item).unwrap();
        }

        let batch = next_batch(&receiver, Duration::from_millis(10)).unwrap();

        let expected: Vec<PathBuf> = ["proj/main.cpp", "proj/novo.cpp"].map(PathBuf::from).into();
        assert_eq!(batch.paths, expected);
        assert!(!batch.rescan);
    }

    #[test]
    fn lost_events_and_watcher_errors_ask_for_a_rescan() {
        let (sender, receiver) = mpsc::channel();
        let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);

        sender.send(Ok(overflow)).unwrap();
        let from_flag = next_batch(&receiver, Duration::ZERO).unwrap();
        sender.send(Err(notify::Error::generic("falhou"))).unwrap();
        let from_error = next_batch(&receiver, Duration::ZERO).unwrap();
        drop(sender);

        assert!(from_flag.rescan && from_error.rescan);
        assert_eq!(next_batch(&receiver, Duration::ZERO), None);
    }

    #[test]
    fn watcher_reports_files_created_in_the_open_folder() {
        let root = TempDir::new("watch");
        let (batches, received) = mpsc::channel();
        let watcher = NotifyWatcher::new(move |batch| {
            let _ = batches.send(batch);
        });

        watcher.watch(&root).unwrap();
        fs::write(root.join("novo.cpp"), "").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let seen = std::iter::from_fn(|| {
            received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .ok()
        })
        .any(|batch| batch.paths.iter().any(|path| path.ends_with("novo.cpp")));
        assert!(seen, "o observador não avisou sobre novo.cpp");
    }
}
