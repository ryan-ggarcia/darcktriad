//! Terminal integrado (docs/specs/terminal.md) com o PTY de verdade: a parte do núcleo dos
//! critérios 8, 9 e 10 e da falha ao criar. Só Unix: os comandos são de shell POSIX. O PTY no
//! Windows é coberto pelo teste de `pty.rs`.
#![cfg(unix)]

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use darktriad_core::{ErrorKind, TerminalEvent, TerminalSize, Terminals};
use darktriad_infra::{PortablePty, detect_default_shell};

const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };
const TIMEOUT: Duration = Duration::from_secs(20);
/// Um quadro (16 ms) menos a folga do relógio entre a thread que entrega e a que anota.
const MIN_GAP: Duration = Duration::from_millis(14);
/// `seq 100000` leva ~0,1 s aqui; o limite deixa folga para CI lento e build sem otimização.
const HUNDRED_K_LINES_BUDGET: Duration = Duration::from_secs(5);
/// O bash 3.2 do macOS expande o `!` de `$!` como histórico ("event not found"); vai em linha
/// própria porque a expansão acontece antes de a linha rodar.
const NO_HISTORY: &str = "set +H 2>/dev/null\r";

type Events = Arc<Mutex<Vec<(Instant, TerminalEvent)>>>;

struct Terminal {
    terminals: Terminals<PortablePty>,
    events: Events,
    id: u32,
}

impl Terminal {
    fn open() -> Self {
        let terminals = Terminals::new(PortablePty, detect_default_shell());
        let events = Events::default();
        let sink = Arc::clone(&events);
        let id = terminals
            .create(&std::env::temp_dir(), SIZE, move |event| {
                sink.lock().unwrap().push((Instant::now(), event));
            })
            .unwrap()
            .id;
        terminals.write(id, NO_HISTORY).unwrap();
        Self {
            terminals,
            events,
            id,
        }
    }

    fn run(&self, command: &str) {
        self.terminals
            .write(self.id, &format!("{command}\r"))
            .unwrap();
    }

    fn output(&self) -> String {
        output_of(&self.events)
    }

    fn wait_for(&self, text: &str) {
        wait_until(text, || self.output().contains(text));
    }
}

fn output_of(events: &Events) -> String {
    events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(_, event)| match event {
            TerminalEvent::Output { data } => Some(data.as_str()),
            TerminalEvent::Exited { .. } => None,
        })
        .collect()
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < TIMEOUT, "esperando {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

/// O número depois de `tag` na saída. O eco do comando digitado (`tag$$`) não tem dígitos.
fn pid_after(output: &str, tag: &str) -> Option<libc::pid_t> {
    output.match_indices(tag).find_map(|(at, _)| {
        let digits: String = output[at + tag.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    })
}

fn alive(pid: libc::pid_t) -> bool {
    // SAFETY: o sinal 0 só consulta se o processo existe.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Critério 8 (parte do núcleo): 100.000 linhas chegam todas, em ordem, rápido e em lotes de no
/// máximo um por quadro.
#[test]
fn hundred_thousand_lines_arrive_whole_in_batches_of_one_per_frame() {
    let terminal = Terminal::open();
    let start = Instant::now();
    // A conta faz o marcador do fim diferir do eco do comando.
    terminal.run("seq 100000; echo fim-$((40+2))");
    terminal.wait_for("fim-42");
    let elapsed = start.elapsed();

    let output = terminal.output();
    let numbers: Vec<u32> = output
        .split("\r\n")
        .filter_map(|line| line.rsplit('\r').next()?.parse().ok())
        .filter(|&n| n >= 1)
        .collect();
    let expected: Vec<u32> = (1..=100_000).collect();
    assert!(
        numbers == expected,
        "{} números, fora de ordem ou faltando",
        numbers.len()
    );
    assert!(!output.contains('\u{FFFD}'));
    assert!(elapsed < HUNDRED_K_LINES_BUDGET, "{elapsed:?}");

    let events = terminal.events.lock().unwrap().clone();
    for pair in events.windows(2) {
        let gap = pair[1].0 - pair[0].0;
        assert!(gap >= MIN_GAP, "dois lotes com {gap:?} de intervalo");
    }
    terminal.terminals.close(terminal.id).unwrap();
}

/// Critério 10 (parte do núcleo): acentos, símbolos, CJK e emoji atravessam o PTY sem virar `�`,
/// mesmo quando uma leitura termina no meio de um caractere.
#[test]
fn unicode_survives_reads_that_split_characters() {
    let terminal = Terminal::open();
    // 23 bytes por grupo: os limites das leituras caem em todas as posições dos caracteres.
    terminal.run(
        "s='ação ✓ 日本 🙂 '; echo ini-$((40+2)); printf \"%.0s$s\" $(seq 20000); echo fim-$((40+3))",
    );
    terminal.wait_for("fim-43");

    let output = terminal.output();
    assert!(!output.contains('\u{FFFD}'), "caractere trocado por �");
    let printed = output.split("ini-42\r\n").nth(1).unwrap();
    let printed = printed.split("fim-43").next().unwrap();
    assert_eq!(printed, "ação ✓ 日本 🙂 ".repeat(20000));
    terminal.terminals.close(terminal.id).unwrap();
}

/// Critério 9 (parte do núcleo): fechar a IDE encerra o shell e os programas de todos os
/// terminais, em primeiro e em segundo plano.
#[test]
fn closing_the_ide_ends_every_shell_and_program() {
    let terminals = Terminals::new(PortablePty, detect_default_shell());
    let mut pids = Vec::new();
    for _ in 0..2 {
        let events = Events::default();
        let sink = Arc::clone(&events);
        let id = terminals
            .create(&std::env::temp_dir(), SIZE, move |event| {
                sink.lock().unwrap().push((Instant::now(), event));
            })
            .unwrap()
            .id;
        terminals.write(id, NO_HISTORY).unwrap();
        let command = "sleep 1000 & echo bg=$!; echo sh=$$; sh -c 'echo fg=$$; exec sleep 1000'\r";
        terminals.write(id, command).unwrap();
        for tag in ["sh=", "bg=", "fg="] {
            wait_until(tag, || pid_after(&output_of(&events), tag).is_some());
            pids.push(pid_after(&output_of(&events), tag).unwrap());
        }
    }
    assert!(pids.iter().all(|&pid| alive(pid)));

    terminals.close_all();

    wait_until("todos terminarem", || pids.iter().all(|&pid| !alive(pid)));
}

/// Muitas escritas pequenas seguidas chegam ao programa na ordem em que foram feitas.
#[test]
fn writes_reach_the_program_in_order() {
    let terminal = Terminal::open();
    // Sem eco, a saída é só o que o `cat` devolve.
    terminal.run("stty -echo; echo pronto-$((1+1)); cat");
    terminal.wait_for("pronto-2");
    let mut expected = String::new();
    for i in 0..2000 {
        terminal
            .terminals
            .write(terminal.id, &format!("a{i}\n"))
            .unwrap();
        expected.push_str(&format!("a{i}\r\n"));
    }
    terminal.wait_for("a1999\r\n");
    let output = terminal.output();
    let start = output.find("a0\r\n").unwrap();
    assert!(output[start..].starts_with(&expected));
    terminal.terminals.close(terminal.id).unwrap();
}

/// Colar 1 MiB num programa que não lê a entrada não prende quem escreve.
#[test]
fn a_big_paste_to_a_program_that_does_not_read_returns_at_once() {
    let terminal = Terminal::open();
    // Sem o modo canônico o terminal não descarta a entrada que sobra: a escrita pararia.
    terminal.run("echo sh=$$; stty raw -echo; sleep 1000");
    wait_until("sh=", || pid_after(&terminal.output(), "sh=").is_some());
    let shell = pid_after(&terminal.output(), "sh=").unwrap();

    let start = Instant::now();
    let paste = "x".repeat(1 << 20);
    terminal.terminals.write(terminal.id, &paste).unwrap();
    terminal.terminals.write(terminal.id, "y").unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "{:?}",
        start.elapsed()
    );

    terminal.terminals.close(terminal.id).unwrap();
    wait_until("o shell terminar", || !alive(shell));
}

/// Fechar o terminal encerra também o programa em segundo plano que ignora o SIGHUP, junto com o
/// shell que também o ignora.
#[test]
fn closing_ends_programs_that_ignore_sighup() {
    let terminal = Terminal::open();
    terminal.run("trap '' HUP; sleep 1001 & echo bg=$!; wait");
    wait_until("bg=", || pid_after(&terminal.output(), "bg=").is_some());
    let sleep = pid_after(&terminal.output(), "bg=").unwrap();
    assert!(alive(sleep));

    terminal.terminals.close(terminal.id).unwrap();

    wait_until("o sleep terminar", || !alive(sleep));
}

/// Ciclo de vida 1: o shell que termina sozinho manda o código de saída por último.
#[test]
fn shell_exit_reports_its_code_last() {
    let terminal = Terminal::open();
    terminal.run("exit 7");
    let exited = || {
        let events = terminal.events.lock().unwrap();
        matches!(events.last(), Some((_, TerminalEvent::Exited { .. })))
    };
    wait_until("o shell terminar", exited);

    let events = terminal.events.lock().unwrap();
    assert_eq!(
        events.last().unwrap().1,
        TerminalEvent::Exited { code: Some(7) }
    );
    let exits = events
        .iter()
        .filter(|(_, event)| matches!(event, TerminalEvent::Exited { .. }))
        .count();
    assert_eq!(exits, 1);
    drop(events);
    let write = terminal.terminals.write(terminal.id, "x").unwrap_err();
    let resize = terminal.terminals.resize(terminal.id, SIZE).unwrap_err();
    assert_eq!(
        (write.kind, resize.kind),
        (ErrorKind::Other, ErrorKind::Other)
    );
    terminal.terminals.close(terminal.id).unwrap();
}

/// Ciclo de vida 4: o shell que não existe vira um erro com o caminho tentado, e os terminais
/// seguem funcionando. Id desconhecido é `notFound` em todos os comandos.
#[test]
fn missing_shell_names_the_path_and_unknown_ids_are_not_found() {
    let missing = Terminals::new(PortablePty, "/nao/existe/zsh".into());
    let error = missing
        .create(&std::env::temp_dir(), SIZE, |_| {})
        .unwrap_err();
    assert!(
        error.message.contains("/nao/existe/zsh"),
        "{}",
        error.message
    );
    assert!(matches!(error.kind, ErrorKind::NotFound | ErrorKind::Other));

    let terminal = Terminal::open();
    terminal.run("echo ok-$((1+1))");
    terminal.wait_for("ok-2");
    let unknown = terminal.id + 100;
    let terminals = &terminal.terminals;
    for error in [
        terminals.write(unknown, "x").unwrap_err(),
        terminals.resize(unknown, SIZE).unwrap_err(),
        terminals.close(unknown).unwrap_err(),
    ] {
        assert_eq!(error.kind, ErrorKind::NotFound);
    }
    terminals.close(terminal.id).unwrap();
}
