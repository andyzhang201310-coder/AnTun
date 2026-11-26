//! Psiphon 出口地区：XEHN 兼容的 ISO alpha-2 地区列表与 EgressRegion 写入。
//! 空地区代表自动选择；非空地区作为偏好写入 Psiphon 官方 client.config。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegionOption {
    code: String,
    name_zh: String,
    name_en: String,
    live: bool,
}

#[derive(Deserialize, Default)]
struct RegionsCache {
    regions: Vec<String>,
}

/// 首次运行、尚无 Psiphon 实时地区缓存时显示的列表（与 XEHN 内置表一致）。
const FALLBACK: &[(&str, &str, &str)] = &[
    ("US", "美国", "United States"),
    ("GB", "英国", "United Kingdom"),
    ("DE", "德国", "Germany"),
    ("FR", "法国", "France"),
    ("NL", "荷兰", "Netherlands"),
    ("CA", "加拿大", "Canada"),
    ("JP", "日本", "Japan"),
    ("KR", "韩国", "South Korea"),
    ("SG", "新加坡", "Singapore"),
    ("HK", "中国香港", "Hong Kong, China"),
    ("IN", "印度", "India"),
    ("AU", "澳大利亚", "Australia"),
    ("RU", "俄罗斯", "Russia"),
    ("TH", "泰国", "Thailand"),
    ("VN", "越南", "Vietnam"),
    ("MY", "马来西亚", "Malaysia"),
    ("ID", "印度尼西亚", "Indonesia"),
    ("PH", "菲律宾", "Philippines"),
    ("TW", "中国台湾", "Taiwan, China"),
    ("MO", "中国澳门", "Macao, China"),
    ("BR", "巴西", "Brazil"),
    ("TR", "土耳其", "Turkey"),
    ("PL", "波兰", "Poland"),
    ("SE", "瑞典", "Sweden"),
    ("CH", "瑞士", "Switzerland"),
    ("IT", "意大利", "Italy"),
    ("ES", "西班牙", "Spain"),
    ("UA", "乌克兰", "Ukraine"),
    ("NZ", "新西兰", "New Zealand"),
    ("ZA", "南非", "South Africa"),
];

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))
}

fn regions_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("psiphon-regions.json"))
}

fn load_live_codes(app: &AppHandle) -> Vec<String> {
    let Ok(path) = regions_path(app) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_str::<RegionsCache>(&text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for code in cache.regions {
        let code = code.trim().to_ascii_uppercase();
        if code.len() == 2 && !out.contains(&code) {
            out.push(code);
        }
    }
    out
}

fn option(code: &str, name_zh: &str, name_en: &str, live: bool) -> RegionOption {
    RegionOption {
        code: code.to_string(),
        name_zh: name_zh.to_string(),
        name_en: name_en.to_string(),
        live,
    }
}

#[tauri::command]
pub fn psiphon_regions(app: AppHandle) -> Vec<RegionOption> {
    let live_codes = load_live_codes(&app);
    let mut out = vec![option("", "自动选择", "Automatic", false)];
    for (code, zh, en) in FALLBACK {
        out.push(option(code, zh, en, live_codes.iter().any(|c| c == code)));
    }
    let mut extras: Vec<String> = live_codes
        .into_iter()
        .filter(|c| !FALLBACK.iter().any(|(code, _, _)| code == c))
        .collect();
    extras.sort();
    for code in extras {
        out.push(option(&code, &code, &code, true));
    }
    out
}

#[tauri::command]
pub fn set_psiphon_region(app: AppHandle, region: String) -> Result<(), String> {
    let region = region.trim().to_ascii_uppercase();
    if !region.is_empty() && (region.len() != 2 || !region.bytes().all(|b| b.is_ascii_uppercase())) {
        return Err("出口地区必须是两位 ISO 国家码或留空自动选择".into());
    }

    let dir = app_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;
    let path = dir.join("client.config");
    if !path.is_file() {
        crate::core::ensure_bundled_extras(&app);
    }
    if !path.is_file() {
        return Err("未找到 Psiphon 官方 client.config".into());
    }

    let text = std::fs::read_to_string(&path).map_err(|e| format!("read client.config: {}", e))?;
    let mut config: Value = serde_json::from_str(&text).map_err(|e| format!("parse client.config: {}", e))?;
    config["EgressRegion"] = json!(region);
    let updated = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize client.config: {}", e))?;
    std::fs::write(&path, updated).map_err(|e| format!("write client.config: {}", e))
}
