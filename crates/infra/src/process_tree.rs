//! Windows: um Job Object com o processo e tudo o que ele iniciar. O sistema não encerra os filhos
//! de quem caiu (o programa sob o netcoredbg sobrava) e o `taskkill /T` não acha os filhos de um
//! pai que já saiu. Quando o handle fecha, inclusive com a queda do app, o que sobrou é encerrado.

use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::{from_ref, null};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};

pub(crate) struct ProcessTree(HANDLE);

// SAFETY: um handle de Job Object pode ser usado e fechado de qualquer thread.
unsafe impl Send for ProcessTree {}

impl ProcessTree {
    // shortcut: o que o processo iniciar antes de entrar no job fica de fora; exigiria criá-lo
    // suspenso, e o `std::process` não dá o handle da thread. Na prática, é questão de microssegundos.
    pub(crate) fn of(child: &Child) -> io::Result<Self> {
        // SAFETY: os ponteiros valem durante as chamadas; o handle fica com `ProcessTree`.
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let tree = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 || AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(tree)
        }
    }

    /// Encerra o processo e tudo o que ele iniciou.
    pub(crate) fn kill(&self) -> bool {
        // SAFETY: o handle é válido enquanto `self` existir.
        unsafe { TerminateJobObject(self.0, 1) != 0 }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: o handle é só deste valor e não é usado depois.
        unsafe { CloseHandle(self.0) };
    }
}
