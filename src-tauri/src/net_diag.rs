//! 网络诊断：DNS 泄漏检测与 AI 站点连通性检测。
//!
//! 所有请求都经本地代理发出，因此结果反映的是"当前隧道出口"的真实表现：
//! - DNS 泄漏检测读取 EDNS 解析器信息（edns.ip-api.com），判断解析器是否仍在本地；
//! - AI 站点检测分别访问 OpenAI / Gemini / Claude 的公开端点，区分"网络不可达"、
//!   "地区被封锁"和"可达（需登录或密钥）"。

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagItem {
    pub name: String,
    pub ok: bool,
    pub status: u16,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagReport {
    pub ok: bool,
    pub kind: String,
    pub summary: String,
    pub exit_ip: String,
    pub exit_country: String,
    pub resolver_ip: String,
    pub resolver_geo: String,
    pub leak: bool,
    pub items: Vec<DiagItem>,
}

fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn temp_body(tag: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("antun-diag-{}-{}.txt", tag, stamp))
}

/// 通过本地代理请求，返回 (HTTP 状态码, 响应体前 4KB)
fn fetch(proxy: &str, url: &str, timeout_sec: u32, tag: &str) -> (u16, String) {
    let body_path = temp_body(tag);
    let out = hidden("curl.exe")
        .args([
            "-sS",
            "-L",
            "--max-time",
            &timeout_sec.to_string(),
            "-x",
            proxy,
            "-o",
            body_path.to_string_lossy().as_ref(),
            "-w",
            "%{http_code}",
            url,
        ])
        .output();
    let status = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().parse::<u16>().unwrap_or(0),
        Err(_) => 0,
    };
    let body = fs::read(&body_path)
        .map(|b| {
            let take = b.len().min(4096);
            String::from_utf8_lossy(&b[..take]).to_string()
        })
        .unwrap_or_default();
    let _ = fs::remove_file(&body_path);
    (status, body)
}

/// 出口 IP 与国家：优先用 ip-api 的归属地（比 trace 的 loc 更接近真实出口国家），
/// 失败时回退到 Cloudflare trace。
fn exit_geo(proxy: &str) -> (String, String) {
    let (status, body) = fetch(
        proxy,
        "http://ip-api.com/json/?fields=status,country,countryCode,city,query",
        8,
        "geo",
    );
    if status == 200 {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            if v["status"].as_str() == Some("success") {
                let ip = v["query"].as_str().unwrap_or("").trim().to_string();
                let cc = v["countryCode"].as_str().unwrap_or("").trim().to_string();
                if !ip.is_empty() {
                    return (ip, cc);
                }
            }
        }
    }
    trace_exit(proxy)
}

fn trace_exit(proxy: &str) -> (String, String) {
    let (_, body) = fetch(proxy, "https://www.cloudflare.com/cdn-cgi/trace", 8, "trace");
    let mut ip = String::new();
    let mut country = String::new();
    for line in body.lines() {
        if let Some(v) = line.strip_prefix("ip=") {
            ip = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("loc=") {
            country = v.trim().to_string();
        }
    }
    (ip, country)
}

fn dns_report(proxy: &str) -> DiagReport {
    let (exit_ip, exit_country) = exit_geo(proxy);
    let (status, body) = fetch(proxy, "https://edns.ip-api.com/json", 10, "dns");
    let mut resolver_ip = String::new();
    let mut resolver_geo = String::new();
    if status == 200 {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            resolver_ip = v["dns"]["ip"].as_str().unwrap_or("").trim().to_string();
            resolver_geo = v["dns"]["geo"].as_str().unwrap_or("").trim().to_string();
        }
    }

    let geo_lower = resolver_geo.to_lowercase();
    let leak = !resolver_ip.is_empty()
        && (geo_lower.contains("china") || geo_lower.contains("cn -") || geo_lower.ends_with(" cn"));
    let (ok, summary) = if status == 0 {
        (
            false,
            "未取到解析器信息：请确认已连接，且核心正在运行".to_string(),
        )
    } else if resolver_ip.is_empty() {
        (false, "解析器信息为空，可能是上游接口不可用".to_string())
    } else if leak {
        (
            false,
            format!(
                "检测到可能的 DNS 泄漏：解析器位于 {}，与出口不在同一侧",
                resolver_geo
            ),
        )
    } else if resolver_ip == exit_ip {
        (true, "无泄漏：解析请求由出口自身完成".to_string())
    } else {
        (
            true,
            format!(
                "无泄漏：解析器 {}（{}），未经过本地运营商",
                resolver_ip, resolver_geo
            ),
        )
    };

    let items = vec![DiagItem {
        name: "DNS 解析器".into(),
        ok: !leak && status == 200,
        status,
        detail: if resolver_ip.is_empty() {
            "未获取到解析器".into()
        } else {
            format!("{} · {}", resolver_ip, resolver_geo)
        },
    }];

    DiagReport {
        ok,
        kind: "dns".into(),
        summary,
        exit_ip,
        exit_country,
        resolver_ip,
        resolver_geo,
        leak,
        items,
    }
}

const AI_TARGETS: &[(&str, &str)] = &[
    ("ChatGPT 网页", "https://chatgpt.com/robots.txt"),
    ("OpenAI API", "https://api.openai.com/v1/models"),
    ("Gemini 网页", "https://gemini.google.com/app"),
    ("Gemini API", "https://generativelanguage.googleapis.com/v1beta/models"),
    ("Claude API", "https://api.anthropic.com/v1/models"),
];

const BLOCK_MARKERS: &[&str] = &[
    "unsupported_country",
    "user location is not supported",
    "not available in your country",
    "not supported in your country",
    "access denied",
    "request blocked",
    "you do not have access",
    "cf-error-details",
];

fn ai_report(proxy: &str) -> DiagReport {
    let (exit_ip, exit_country) = exit_geo(proxy);
    let mut items = Vec::new();
    let mut reachable = 0usize;

    for (idx, (name, url)) in AI_TARGETS.iter().enumerate() {
        let (status, body) = fetch(proxy, url, 10, &format!("ai{}", idx));
        let lower = body.to_lowercase();
        let blocked = BLOCK_MARKERS.iter().any(|m| lower.contains(m));
        // 缺少密钥/登录时的标准响应同样说明网络链路已通
        let key_hint = [
            "api key",
            "api_key",
            "unregistered callers",
            "authentication",
            "credential",
            "missing key",
        ]
        .iter()
        .any(|m| lower.contains(m));
        let (ok, detail) = if status == 0 {
            (false, "连接失败（超时或被重置）".to_string())
        } else if blocked {
            (false, format!("HTTP {} · 地区或 IP 被拒绝", status))
        } else if key_hint || status == 401 {
            (true, format!("HTTP {} · 可达（需登录或密钥）", status))
        } else if status == 403 {
            (false, "HTTP 403 · 被拒绝（IP 或地区）".to_string())
        } else if (200..400).contains(&status) {
            (true, format!("HTTP {} · 可访问", status))
        } else if status == 429 {
            (true, "HTTP 429 · 可达（触发限流）".to_string())
        } else {
            (false, format!("HTTP {} · 异常响应", status))
        };
        if ok {
            reachable += 1;
        }
        items.push(DiagItem {
            name: name.to_string(),
            ok,
            status,
            detail,
        });
    }

    let summary = if reachable == AI_TARGETS.len() {
        format!("{} 项全部可达，当前出口可访问 ChatGPT / Gemini / Claude", reachable)
    } else if reachable == 0 {
        "全部不可达：出口 IP 可能被拒绝，建议切换到「节点出口」并选择美国/日本/新加坡节点".to_string()
    } else {
        format!(
            "{}/{} 项可达；被拒绝的站点通常需要更换出口 IP（WARP 共享 IP 常被风控）",
            reachable,
            AI_TARGETS.len()
        )
    };

    DiagReport {
        ok: reachable == AI_TARGETS.len(),
        kind: "ai".into(),
        summary,
        exit_ip,
        exit_country,
        resolver_ip: String::new(),
        resolver_geo: String::new(),
        leak: false,
        items,
    }
}

/// 网络诊断入口：kind = dns | ai，port 为本地混合代理端口。
#[tauri::command]
pub async fn net_diagnose(port: u16, kind: String) -> Result<DiagReport, String> {
    let proxy = format!("http://127.0.0.1:{}", port);
    let report = if kind == "ai" {
        ai_report(&proxy)
    } else {
        dns_report(&proxy)
    };
    Ok(report)
}
