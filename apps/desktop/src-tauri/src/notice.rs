// 系统消息框：提示、问“是 / 否”。用 Windows 自带的 MessageBoxW（自己声明，不加依赖），不往网页注入任何东西。
// 消息框会挡住调用它的线程，直到人点了按钮：后台线程里直接用 tell、ask；窗口回调在主线程里，要用 tell_later。

use std::ffi::c_void;

/// 程序名：窗口标题、托盘提示、消息框标题都用它
pub const TITLE: &str = "甬勒ERP";

const MB_YESNO: u32 = 0x4;
const MB_ICONQUESTION: u32 = 0x20;
const MB_ICONWARNING: u32 = 0x30;
const MB_ICONINFORMATION: u32 = 0x40;
const MB_DEFBUTTON2: u32 = 0x100;
const MB_SETFOREGROUND: u32 = 0x1_0000;
const IDYES: i32 = 6;

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Info,
    Warning,
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(owner: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

/// 弹一个提示框，等人点“确定”
pub fn tell(text: &str, kind: Kind) {
    let icon = match kind {
        Kind::Info => MB_ICONINFORMATION,
        Kind::Warning => MB_ICONWARNING,
    };
    show(text, icon);
}

/// 在新线程里弹提示框，调用的线程不等（窗口回调在主线程里，在那里弹框会卡住窗口）
pub fn tell_later(text: String, kind: Kind) {
    std::thread::spawn(move || tell(&text, kind));
}

/// 问“是 / 否”，默认按钮是“否”；点了“是”返回 true
pub fn ask(text: &str) -> bool {
    show(text, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES
}

fn show(text: &str, flags: u32) -> i32 {
    let text = wide(text);
    let caption = wide(TITLE);
    // SAFETY: text、caption 都以 0 结尾、调用期间有效；没有父窗口时句柄传空
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            flags | MB_SETFOREGROUND,
        )
    }
}

/// 以 0 结尾的 UTF-16
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
