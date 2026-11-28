//! 内置广告 / 追踪域名清单（`DOMAIN-SUFFIX → REJECT`）。
//!
//! 为什么用内置静态清单而不是 rule-provider：本项目的前提是核心按需下载、离线可用。
//! 远程 mrs/srs 规则集要联网拉取，首次连接或断网时会失败，还会拖动启动耗时；
//! 静态清单写进配置，核心启动即可用，没有额外网络依赖。
//!
//! 选词原则：只收「纯广告 / 纯追踪」的域名。
//!  - 不收任何内容分发（CDN、图床、视频）域名，否则会把正常页面打死；
//!  - 不收登录取数（如 connect.facebook.net）这类一旦拦掉就会导致站点功能坏掉的域名；
//!  - 明确属于广告交易、投放、监测、统计的才进清单。

/// 广告交易 / DSP / SSP / 原生广告平台
const AD_EXCHANGE: &[&str] = &[
    "adnxs.com",
    "adsrvr.org",
    "rubiconproject.com",
    "pubmatic.com",
    "openx.net",
    "casalemedia.com",
    "criteo.com",
    "criteo.net",
    "taboola.com",
    "outbrain.com",
    "mgid.com",
    "revcontent.com",
    "zedo.com",
    "advertising.com",
    "adtechus.com",
    "atwola.com",
    "yieldmo.com",
    "sharethrough.com",
    "triplelift.com",
    "33across.com",
    "bidswitch.net",
    "contextweb.com",
    "gumgum.com",
    "indexww.com",
    "inmobi.com",
    "smartadserver.com",
    "serving-sys.com",
    "sizmek.com",
    "spotxchange.com",
    "teads.tv",
    "tremorhub.com",
    "undertone.com",
    "sovrn.com",
    "lijit.com",
    "rfihub.com",
    "turn.com",
    "sitescout.com",
    "simpli.fi",
    "owneriq.net",
    "narrative.io",
];

/// 用户画像 / 监测 / 统计（跨站追踪像素、DMP）
const AD_TRACKING: &[&str] = &[
    "scorecardresearch.com",
    "quantserve.com",
    "moatads.com",
    "demdex.net",
    "omtrdc.net",
    "everesttech.net",
    "krxd.net",
    "mathtag.com",
    "ml314.com",
    "exelator.com",
    "bluekai.com",
    "adsymptotic.com",
    "agkn.com",
    "rlcdn.com",
    "tapad.com",
    "liadm.com",
    "crwdcntrl.net",
    "eyeota.net",
    "zeotap.com",
];

/// 移动端广告 SDK
const AD_MOBILE: &[&str] = &[
    "adcolony.com",
    "applovin.com",
    "chartboost.com",
    "ironsrc.com",
    "supersonicads.com",
    "unityads.unity3d.com",
    "mopub.com",
    "fyber.com",
    "digitalturbine.com",
    "inner-active.mobi",
    "tapjoy.com",
    "heyzap.com",
    "startapp.com",
    "vungle.com",
];

/// 弹窗 / 跳转类广告联盟
const AD_POPUP: &[&str] = &[
    "adsterra.com",
    "propellerads.com",
    "popads.net",
    "popcash.net",
    "exoclick.com",
    "juicyads.com",
    "trafficjunky.com",
    "adcash.com",
    "clickadu.com",
    "hilltopads.net",
];

/// 大厂自有广告与统计域（Google / 微软 / 亚马逊）
const AD_BIGTECH: &[&str] = &[
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
    "google-analytics.com",
    "googletagservices.com",
    "googletagmanager.com",
    "2mdn.net",
    "adservice.google.com",
    "bat.bing.com",
    "clarity.ms",
    "msads.net",
    "ads.msn.com",
    "amazon-adsystem.com",
    "assoc-amazon.com",
];

/// 国内广告监测 / 统计域
const AD_CN: &[&str] = &[
    "umeng.com",
    "umengcloud.com",
    "umeng.co",
    "cnzz.com",
    "talkingdata.com",
    "talkingdata.net",
    "growingio.com",
    "sensorsdata.cn",
    "miaozhen.com",
    "admaster.com.cn",
    "irs01.com",
    "irs01.net",
    "tanx.com",
    "pos.baidu.com",
    "hm.baidu.com",
    "cpro.baidu.com",
    "cbjs.baidu.com",
    "gdt.qq.com",
];

/// 全部后缀（分组只为了可读性，渲染时不区分来源）
pub fn domains() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = Vec::new();
    for group in [AD_BIGTECH, AD_EXCHANGE, AD_TRACKING, AD_MOBILE, AD_POPUP, AD_CN] {
        v.extend_from_slice(group);
    }
    v.sort_unstable();
    v.dedup();
    v
}

/// 渲染成 mihomo 规则行（每行自带两空格缩进和换行，方便直接拼进模板）
pub fn rules() -> String {
    let mut s = String::new();
    for d in domains() {
        s.push_str(&format!("  - DOMAIN-SUFFIX,{},REJECT\n", d));
    }
    s
}

/// 规则页展示用：条数 + 前几条样例
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdBlockInfo {
    pub count: usize,
    pub samples: Vec<String>,
}

#[tauri::command]
pub fn ad_block_info() -> AdBlockInfo {
    let all = domains();
    AdBlockInfo {
        count: all.len(),
        samples: all.iter().take(6).map(|s| s.to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_sane() {
        let all = domains();
        assert!(all.len() > 80, "广告域名清单过少: {}", all.len());
        for d in &all {
            assert!(!d.is_empty(), "空域名");
            assert!(!d.starts_with('.'), "不要带前导点: {d}");
            assert!(!d.contains(',') && !d.contains(' '), "非法字符: {d}");
            assert_eq!(*d, d.to_lowercase(), "必须小写: {d}");
            // 内容 CDN / 视频域名一旦拦掉会直接把页面打死，这里做一道兜底检查
            for bad in ["googlevideo.com", "ytimg.com", "gstatic.com", "cloudflare.com", "qq.com"] {
                assert_ne!(*d, bad, "不能拦截内容域名: {d}");
            }
        }
    }

    #[test]
    fn rules_are_valid_mihomo_lines() {
        let r = rules();
        let first = r.lines().next().unwrap();
        assert!(first.starts_with("  - DOMAIN-SUFFIX,"), "{first}");
        assert!(first.ends_with(",REJECT"), "{first}");
        assert_eq!(r.lines().count(), domains().len());
    }

    #[test]
    fn info_matches_rules() {
        let info = ad_block_info();
        assert_eq!(info.count, domains().len());
        assert_eq!(info.samples.len(), 6);
    }
}
