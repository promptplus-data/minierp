//! Raw ESC/POS printing to a Windows printer queue.
//!
//! The web UI (served by the main machine) renders the receipt to ESC/POS bytes and
//! calls the `print_receipt` command; we hand the bytes to the spooler with the
//! "RAW" datatype so the driver does not touch them.
//!
//! UNTESTED: written against the winspool API but never run on a real printer.
//! Not handled yet: listing printers, cash-drawer kick, USB/serial printers
//! without a Windows queue.

#[cfg(windows)]
pub fn print_raw(printer_name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_HANDLE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let last_error = || std::io::Error::last_os_error().to_string();

    let name = wide(printer_name);
    let mut doc_name = wide("SCG Shop ERP receipt");
    let mut datatype = wide("RAW");

    // SAFETY: all pointers point to live, NUL-terminated buffers owned by this frame,
    // and the handle is closed on every path after a successful OpenPrinterW.
    unsafe {
        let mut handle: PRINTER_HANDLE = std::mem::zeroed();
        if OpenPrinterW(name.as_ptr(), &mut handle, null()) == 0 {
            return Err(format!("cannot open printer '{printer_name}': {}", last_error()));
        }
        let doc = DOC_INFO_1W {
            pDocName: doc_name.as_mut_ptr(),
            pOutputFile: null_mut(),
            pDatatype: datatype.as_mut_ptr(),
        };
        let result = (|| {
            if StartDocPrinterW(handle, 1, &doc) == 0 {
                return Err(format!("StartDocPrinter failed: {}", last_error()));
            }
            if StartPagePrinter(handle) == 0 {
                EndDocPrinter(handle);
                return Err(format!("StartPagePrinter failed: {}", last_error()));
            }
            let mut written: u32 = 0;
            let ok = WritePrinter(handle, bytes.as_ptr().cast(), bytes.len() as u32, &mut written);
            EndPagePrinter(handle);
            EndDocPrinter(handle);
            if ok == 0 {
                return Err(format!("WritePrinter failed: {}", last_error()));
            }
            if written as usize != bytes.len() {
                return Err(format!("short write: {written} of {} bytes", bytes.len()));
            }
            Ok(())
        })();
        ClosePrinter(handle);
        result
    }
}

#[cfg(not(windows))]
pub fn print_raw(printer_name: &str, bytes: &[u8]) -> Result<(), String> {
    // TODO: CUPS raw queue (`lp -o raw`) if a Linux/macOS client is ever needed.
    Err(format!(
        "receipt printing is only implemented on Windows (printer '{printer_name}', {} bytes)",
        bytes.len()
    ))
}
