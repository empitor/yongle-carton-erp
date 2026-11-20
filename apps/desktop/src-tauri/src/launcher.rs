// 甬勒ERP.exe：员工双击的唯一程序。按完整路径加载同目录下的客户端核心 yongle_erp_core.dll，在自己这个进程里调它的入口
// yongle_erp_run_v1，一直跑到程序退出；窗口、托盘、单实例、下载和应用内更新都在核心里（lib.rs）。
// 这里不引任何库，只用标准库和 Windows 自带的几个函数。核心找不到、和启动器不是同一版、起不来时弹系统消息框说明。
// 只在 Windows 上编译。发布版是 Windows 子系统（不带控制台）；开发版留着控制台，核心的出错记录能直接看到。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// 核心 dll 的文件名（Cargo.toml 里 [lib] 的名字）和它导出的入口；入口名带接口版本，
/// 入口的参数或约定改了就换名字，旧启动器配新核心（或反过来）时找不到入口、弹框说明，不会乱调
const CORE: &str = "yongle_erp_core.dll";
const ENTRY: &[u8] = b"yongle_erp_run_v1\0";
/// 消息框标题
const TITLE: &str = "甬勒ERP";

/// 程序所在目录、系统目录和进程里用 AddDllDirectory 登记过的目录（输入法、外壳扩展这类组件要用），
/// 不含当前目录和 PATH：进程里之后按名字加载的 dll 都按这个找（微软推荐的写法）
const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x1000;
/// 加载核心时，它依赖的 dll 另外从它自己所在的目录找
const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x100;
const MB_ICONERROR: u32 = 0x10;

/// 核心起不来时用它交回原因：以 0 结尾的 UTF-16 文字
type Report = extern "C" fn(*const u16);
type Run = extern "C" fn(Report) -> i32;

#[link(name = "kernel32")]
extern "system" {
    fn SetDefaultDllDirectories(flags: u32) -> i32;
    fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(owner: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

/// 启动器所在目录里的核心
fn core_beside(launcher: &Path) -> Option<PathBuf> {
    launcher.parent().map(|dir| dir.join(CORE))
}

fn main() {
    // SAFETY: 只传规定的标志位；失败时（极旧的系统）照原来的搜索顺序继续，加载核心那一步另有限制
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    }
    let code = match load_core() {
        Ok(run) => run(report),
        Err(message) => {
            show_error(&message);
            1
        }
    };
    std::process::exit(code);
}

fn load_core() -> Result<Run, String> {
    let me = std::env::current_exe().map_err(|e| format!("找不到程序自己的位置：{e}"))?;
    let core = core_beside(&me).ok_or("程序不在任何目录里")?;
    load(&core, ENTRY).map_err(|e| format!("加载不了 {}：{e}", core.display()))
}

/// 按完整路径加载 dll、取出入口；dll 一直留在进程里，不卸载
fn load(path: &Path, entry: &[u8]) -> Result<Run, String> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
    // SAFETY: 路径以 0 结尾、调用期间有效；第二个参数按规定传空
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), flags) };
    if module.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: module 是刚加载成功的 dll，entry 以 0 结尾
    let address = unsafe { GetProcAddress(module, entry.as_ptr()) };
    if address.is_null() {
        return Err("里面没有这个启动器要的入口，程序和核心不是同一版本，请重新安装".into());
    }
    // SAFETY: 核心 lib.rs 用 extern "C" fn(Report) -> i32 导出了这个入口，签名一致（入口名带接口版本）
    Ok(unsafe { std::mem::transmute::<*mut c_void, Run>(address) })
}

/// 核心交回的原因，弹出来
extern "C" fn report(text: *const u16) {
    message_box(text);
}

fn show_error(text: &str) {
    message_box(wide(text).as_ptr());
}

fn message_box(text: *const u16) {
    let caption = wide(TITLE);
    // SAFETY: text 和 caption 都以 0 结尾、调用期间有效；没有父窗口时句柄传空
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text, caption.as_ptr(), MB_ICONERROR);
    }
}

/// 以 0 结尾的 UTF-16
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_core_is_looked_up_next_to_the_launcher() {
        let launcher = Path::new(r"C:\Users\someone\AppData\Local\甬勒ERP\甬勒ERP.exe");
        assert_eq!(
            core_beside(launcher),
            Some(PathBuf::from(
                r"C:\Users\someone\AppData\Local\甬勒ERP\yongle_erp_core.dll"
            ))
        );
    }

    #[test]
    fn a_bare_root_has_no_core() {
        assert_eq!(core_beside(Path::new("")), None);
    }

    #[test]
    fn a_missing_core_is_reported_instead_of_crashing() {
        let missing = std::env::temp_dir().join("没有这个文件").join(CORE);
        assert!(load(&missing, ENTRY).is_err());
    }
}
