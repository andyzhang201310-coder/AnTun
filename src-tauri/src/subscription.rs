//! 订阅模式：抓取 http/https 订阅，解析为 mihomo 出站节点。
//! 解析出的节点以 `SUB-NODE` 固定名写回配置，作为 WARP 隧道的 dialer-proxy。

use base64::engine::general_purpose::{STANDARD, URL_SAFE};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubNode {
    pub id: String,
    pub sub_id: String,
    pub name: String,
    pub node_type: String,
    pub server: String,
    pub port: u16,
    /// 完整的 mihomo 出站块（两空格缩进的列表项）
    pub config: String,
}

#[tauri::command]
pub fn subscription_fetch(url: String) -> Result<Vec<SubNode>, String> {
    let text = fetch_text(&url)?;
    let mut nodes = parse_subscription(&text)?;
    for node in &mut nodes {
        node.sub_id = url.clone();
    }
    Ok(nodes)
}

/// 直接解析粘贴的订阅文本 / 节点链接，不经过网络。
#[tauri::command]
pub fn subscription_parse(content: String) -> Result<Vec<SubNode>, String> {
    let mut nodes = parse_subscription(&content)?;
    for node in &mut nodes {
        node.sub_id = "pasted".into();
    }
    Ok(nodes)
}

#[cfg(windows)]
fn hidden_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(windows))]
fn hidden_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

fn fetch_text(url: &str) -> Result<String, String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("订阅地址需以 http:// 或 https:// 开头".into());
    }
    let out = hidden_cmd("curl.exe")
        .args([
            "-sSL",
            "--fail",
            "--max-time",
            "30",
            "-A",
            "AnTun/1.0 (+subscription)",
            url,
        ])
        .output()
        .map_err(|e| format!("订阅请求失败: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("订阅下载失败: {}", if err.is_empty() { "HTTP 错误" } else { &err }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn decode_b64(input: &str) -> Option<Vec<u8>> {
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.is_empty() {
        return None;
    }
    let mut padded = clean;
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    STANDARD.decode(&padded).ok().or_else(|| URL_SAFE.decode(&padded).ok())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = hex_val(bytes[i + 1]);
            let l = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn q(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn make_node(name: &str, node_type: &str, server: &str, port: u16, extra: &[String]) -> SubNode {
    let mut config = format!(
        "  - name: \"SUB-NODE\"\n    type: {}\n    server: {}\n    port: {}\n",
        q(&node_type.to_ascii_lowercase()),
        q(server),
        port
    );
    for line in extra {
        config.push_str(line);
        config.push('\n');
    }
    SubNode {
        id: format!("{}@{}:{}", name, server, port),
        sub_id: String::new(),
        name: if name.is_empty() { format!("{}:{}", server, port) } else { name.to_string() },
        node_type: node_type.to_ascii_lowercase(),
        server: server.to_string(),
        port,
        config,
    }
}

fn host_port(input: &str) -> Option<(String, u16)> {
    let s = input.trim();
    let (host, port_s) = if let Some(rest) = s.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = &rest[..end];
        let tail = &rest[end + 1..];
        let port_s = tail.strip_prefix(':')?;
        (host, port_s)
    } else {
        let (host, port_s) = s.rsplit_once(':')?;
        (host, port_s)
    };
    let port = port_s.parse::<u16>().ok()?;
    Some((host.to_string(), port))
}

fn query_value(query: &str, key: &str) -> String {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k.eq_ignore_ascii_case(key) {
                return percent_decode(v);
            }
        }
    }
    String::new()
}

fn parse_yaml(text: &str) -> Vec<SubNode> {
    let lines: Vec<&str> = text.lines().collect();
    let mut start = None;
    let mut base_indent = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("proxies:") {
            if rest.trim().is_empty() {
                start = Some(i + 1);
                base_indent = line.len() - trimmed.len();
                break;
            }
        }
    }
    let Some(start) = start else { return vec![] };

    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut current: Option<Vec<String>> = None;
    for line in &lines[start..] {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim_start();
        if indent <= base_indent && !trimmed.starts_with('-') {
            break;
        }
        if let Some(item) = trimmed.strip_prefix("- ") {
            if let Some(block) = current.take() {
                blocks.push(block);
            }
            current = Some(vec![item.to_string()]);
        } else if let Some(block) = current.as_mut() {
            block.push((*line).to_string());
        }
    }
    if let Some(block) = current {
        blocks.push(block);
    }

    let mut nodes = Vec::new();
    for block in blocks {
        let field = |key: &str| -> String {
            for line in &block {
                let t = line.trim_start().trim_start_matches("- ").trim();
                if let Some((k, v)) = t.split_once(':') {
                    if k.trim() == key {
                        return unquote(v);
                    }
                }
            }
            String::new()
        };
        let node_type = field("type");
        let server = field("server");
        let port = field("port").parse::<u16>().unwrap_or(0);
        let display = field("name");
        if node_type.is_empty() || server.is_empty() || port == 0 {
            continue;
        }

        let mut config = String::from("  - name: \"SUB-NODE\"\n");
        for (idx, line) in block.iter().enumerate() {
            let (content, is_first) = if idx == 0 {
                (line.trim_start().trim_start_matches("- ").trim_start().to_string(), true)
            } else {
                ((*line).to_string(), false)
            };
            if content.trim_start().starts_with("name:") {
                continue;
            }
            let indented = if is_first {
                format!("    {}", content)
            } else if content.starts_with("    ") {
                content
            } else {
                format!("    {}", content.trim_start())
            };
            config.push_str(&indented);
            config.push('\n');
        }
        nodes.push(SubNode {
            id: format!("{}@{}:{}", display, server, port),
            sub_id: String::new(),
            name: if display.is_empty() { format!("{}:{}", server, port) } else { display },
            node_type: node_type.to_ascii_lowercase(),
            server,
            port,
            config,
        });
    }
    nodes
}

fn parse_ss(rest: &str) -> Option<SubNode> {
    let (main, fragment) = match rest.split_once('#') {
        Some((m, f)) => (m, f),
        None => (rest, ""),
    };
    let (userinfo, hp) = main.split_once('@')?;
    let (server, port) = host_port(hp)?;
    let credentials = decode_b64(userinfo)
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| percent_decode(userinfo));
    let (cipher, password) = credentials.split_once(':')?;
    Some(make_node(
        &percent_decode(fragment),
        "ss",
        &server,
        port,
        &[
            format!("    cipher: {}", q(cipher)),
            format!("    password: {}", q(password)),
            "    udp: true".to_string(),
        ],
    ))
}

fn parse_vmess(rest: &str) -> Option<SubNode> {
    let bytes = decode_b64(rest)?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let get = |key: &str| -> String {
        v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
    };
    let server = get("add");
    let port = v.get("port").and_then(Value::as_u64).unwrap_or(443) as u16;
    let uuid = get("id");
    if server.is_empty() || uuid.is_empty() {
        return None;
    }
    let network = get("net");
    let host = get("host");
    let path = get("path");
    let tls = get("tls");
    let sni = get("sni");
    let mut extra = vec![
        format!("    uuid: {}", q(&uuid)),
        format!("    alterId: {}", v.get("aid").and_then(Value::as_u64).unwrap_or(0)),
        "    cipher: auto".to_string(),
        "    udp: true".to_string(),
    ];
    if !network.is_empty() {
        extra.push(format!("    network: {}", q(&network)));
    }
    if network == "ws" || !path.is_empty() || !host.is_empty() {
        extra.push("    ws-opts:".to_string());
        if !path.is_empty() {
            extra.push(format!("      path: {}", q(&path)));
        }
        if !host.is_empty() {
            extra.push("      headers:".to_string());
            extra.push(format!("        Host: {}", q(&host)));
        }
    }
    if tls == "tls" || tls == "1" || tls == "true" {
        extra.push("    tls: true".to_string());
        if !sni.is_empty() || !host.is_empty() {
            extra.push(format!("    server-name: {}", q(if sni.is_empty() { &host } else { &sni })));
        }
    }
    Some(make_node(&get("ps"), "vmess", &server, port, &extra))
}

fn parse_trojan(rest: &str) -> Option<SubNode> {
    let (main, fragment) = match rest.split_once('#') {
        Some((m, f)) => (m, f),
        None => (rest, ""),
    };
    let (main, query) = match main.split_once('?') {
        Some((m, q)) => (m, q),
        None => (main, ""),
    };
    let (password, hp) = main.split_once('@')?;
    let (server, port) = host_port(hp)?;
    let mut extra = vec![format!("    password: {}", q(&percent_decode(password))), "    udp: true".to_string()];
    let sni = query_value(query, "sni");
    if !sni.is_empty() {
        extra.push(format!("    sni: {}", q(&sni)));
    }
    Some(make_node(&percent_decode(fragment), "trojan", &server, port, &extra))
}

fn parse_vless(rest: &str) -> Option<SubNode> {
    let (main, fragment) = match rest.split_once('#') {
        Some((m, f)) => (m, f),
        None => (rest, ""),
    };
    let (main, query) = match main.split_once('?') {
        Some((m, q)) => (m, q),
        None => (main, ""),
    };
    let (uuid, hp) = main.split_once('@')?;
    let (server, port) = host_port(hp)?;
    let mut extra = vec![format!("    uuid: {}", q(&percent_decode(uuid))), "    udp: true".to_string()];
    let sni = query_value(query, "sni");
    let host = query_value(query, "host");
    let path = query_value(query, "path");
    let network = query_value(query, "type");
    let security = query_value(query, "security");
    if !network.is_empty() {
        extra.push(format!("    network: {}", q(&network)));
    }
    if !path.is_empty() || !host.is_empty() {
        extra.push("    ws-opts:".to_string());
        if !path.is_empty() {
            extra.push(format!("      path: {}", q(&path)));
        }
        if !host.is_empty() {
            extra.push("      headers:".to_string());
            extra.push(format!("        Host: {}", q(&host)));
        }
    }
    if !security.is_empty() && security != "none" {
        extra.push("    tls: true".to_string());
        if !sni.is_empty() {
            extra.push(format!("    server-name: {}", q(&sni)));
        }
    }
    Some(make_node(&percent_decode(fragment), "vless", &server, port, &extra))
}

fn parse_proxy_uri(line: &str) -> Option<SubNode> {
    let (scheme, rest) = line.split_once("://")?;
    match scheme.to_ascii_lowercase().as_str() {
        "ss" => parse_ss(rest),
        "vmess" => parse_vmess(rest),
        "trojan" => parse_trojan(rest),
        "vless" => parse_vless(rest),
        "socks5" | "socks" | "http" | "https" => {
            let typ = if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") { "http" } else { "socks5" };
            let (main, fragment) = match rest.split_once('#') {
                Some((m, f)) => (m, f),
                None => (rest, ""),
            };
            let (userinfo, hp) = match main.rsplit_once('@') {
                Some((u, h)) => (u, h),
                None => ("", main),
            };
            let (server, port) = host_port(hp)?;
            let mut extra = Vec::new();
            if !userinfo.is_empty() {
                let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
                extra.push(format!("    username: {}", q(&percent_decode(user))));
                if !pass.is_empty() {
                    extra.push(format!("    password: {}", q(&percent_decode(pass))));
                }
            }
            extra.push("    udp: true".to_string());
            Some(make_node(&percent_decode(fragment), typ, &server, port, &extra))
        }
        _ => None,
    }
}

fn parse_uri_lines(text: &str) -> Vec<SubNode> {
    text.lines()
        .filter_map(|line| {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                return None;
            }
            parse_proxy_uri(t)
        })
        .collect()
}

fn parse_subscription(text: &str) -> Result<Vec<SubNode>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("订阅内容为空".into());
    }
    let mut decoded = trimmed.to_string();
    if !trimmed.contains("proxies:") && !trimmed.lines().any(|l| l.trim().to_ascii_lowercase().contains("://")) {
        if let Some(bytes) = decode_b64(trimmed) {
            if let Ok(s) = String::from_utf8(bytes) {
                decoded = s;
            }
        }
    }
    let mut nodes = parse_yaml(&decoded);
    if nodes.is_empty() {
        nodes = parse_uri_lines(&decoded);
    }
    if nodes.is_empty() {
        return Err("订阅里没有可识别的节点（支持 Clash YAML、ss/vmess/trojan/vless/socks5/http 链接）".into());
    }
    Ok(nodes)
}
