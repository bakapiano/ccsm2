use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewBuilder, WebviewUrl, Window,
    webview::NewWindowResponse,
};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserBounds {
    fn validated(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|value| !value.is_finite())
        {
            return Err("browser bounds must be finite".into());
        }
        if self.width < 1.0 || self.height < 1.0 {
            return Err("browser bounds must be at least 1 × 1".into());
        }
        Ok(self)
    }

    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct BrowserInfo {
    pub surface_id: String,
    pub engine: String,
    pub url: String,
    pub reused: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct BrowserOpenRequest {
    pub source_surface_id: String,
    pub url: String,
}

pub struct BrowserSurfaceManager {
    profile_dir: PathBuf,
    labels: Mutex<HashMap<String, String>>,
}

impl BrowserSurfaceManager {
    pub fn new(profile_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&profile_dir)
            .map_err(|error| format!("create browser profile directory failed: {error}"))?;
        Ok(Self {
            profile_dir,
            labels: Mutex::new(HashMap::new()),
        })
    }

    pub fn create(
        &self,
        window: &Window,
        surface_id: &str,
        bounds: BrowserBounds,
        url: &str,
    ) -> Result<BrowserInfo, String> {
        let bounds = bounds.validated()?;
        let parsed_url = parse_browser_url(url)?;
        let label = surface_label(surface_id);
        if let Some(webview) = window.app_handle().get_webview(&label) {
            webview
                .set_bounds(bounds.rect())
                .map_err(|error| format!("set existing browser bounds failed: {error}"))?;
            webview
                .navigate(parsed_url.clone())
                .map_err(|error| format!("navigate existing browser failed: {error}"))?;
            webview
                .show()
                .map_err(|error| format!("show existing browser failed: {error}"))?;
            return Ok(BrowserInfo {
                surface_id: surface_id.to_string(),
                engine: browser_engine().into(),
                url: parsed_url.to_string(),
                reused: true,
            });
        }

        let app_handle = window.app_handle().clone();
        let source_surface_id = surface_id.to_string();
        let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed_url.clone()))
            .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
            .on_new_window(move |url, _features| {
                if matches!(url.scheme(), "http" | "https" | "about") {
                    let _ = app_handle.emit(
                        "ccsm:browser-new-window",
                        BrowserOpenRequest {
                            source_surface_id: source_surface_id.clone(),
                            url: url.to_string(),
                        },
                    );
                }
                NewWindowResponse::Deny
            })
            .enable_clipboard_access()
            .devtools(cfg!(debug_assertions))
            .data_directory(self.profile_dir.clone());

        #[cfg(all(target_os = "windows", debug_assertions))]
        {
            builder = builder.additional_browser_args(
                "--remote-debugging-port=9227 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
            );
        }

        window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|error| format!("create child WebView failed: {error}"))?;
        self.labels
            .lock()
            .map_err(|_| "browser surface lock poisoned".to_string())?
            .insert(surface_id.to_string(), label);
        Ok(BrowserInfo {
            surface_id: surface_id.to_string(),
            engine: browser_engine().into(),
            url: parsed_url.to_string(),
            reused: false,
        })
    }

    pub fn set_bounds(
        &self,
        app: &tauri::AppHandle,
        surface_id: &str,
        bounds: BrowserBounds,
    ) -> Result<(), String> {
        let bounds = bounds.validated()?;
        self.get(app, surface_id)?
            .set_bounds(bounds.rect())
            .map_err(|error| format!("set browser bounds failed: {error}"))
    }

    pub fn set_visible(
        &self,
        app: &tauri::AppHandle,
        surface_id: &str,
        visible: bool,
    ) -> Result<(), String> {
        let browser = self.get(app, surface_id)?;
        if visible {
            browser
                .show()
                .map_err(|error| format!("show browser failed: {error}"))
        } else {
            browser
                .hide()
                .map_err(|error| format!("hide browser failed: {error}"))
        }
    }

    pub fn focus(&self, app: &tauri::AppHandle, surface_id: &str) -> Result<(), String> {
        self.get(app, surface_id)?
            .set_focus()
            .map_err(|error| format!("focus browser failed: {error}"))
    }

    pub fn navigate(
        &self,
        app: &tauri::AppHandle,
        surface_id: &str,
        url: &str,
    ) -> Result<String, String> {
        let parsed_url = parse_browser_url(url)?;
        self.get(app, surface_id)?
            .navigate(parsed_url.clone())
            .map_err(|error| format!("navigate browser failed: {error}"))?;
        Ok(parsed_url.to_string())
    }

    pub fn reload(&self, app: &tauri::AppHandle, surface_id: &str) -> Result<(), String> {
        self.get(app, surface_id)?
            .reload()
            .map_err(|error| format!("reload browser failed: {error}"))
    }

    pub fn close(&self, app: &tauri::AppHandle, surface_id: &str) -> Result<(), String> {
        let label = self
            .labels
            .lock()
            .map_err(|_| "browser surface lock poisoned".to_string())?
            .remove(surface_id)
            .unwrap_or_else(|| surface_label(surface_id));
        if let Some(browser) = app.get_webview(&label) {
            browser
                .close()
                .map_err(|error| format!("close browser failed: {error}"))?;
        }
        Ok(())
    }

    pub fn shutdown(&self, app: &tauri::AppHandle) {
        let surfaces = self
            .labels
            .lock()
            .map(|mut labels| labels.drain().map(|(_, label)| label).collect::<Vec<_>>())
            .unwrap_or_default();
        for label in surfaces {
            if let Some(browser) = app.get_webview(&label) {
                let _ = browser.close();
            }
        }
    }

    fn get(&self, app: &tauri::AppHandle, surface_id: &str) -> Result<tauri::Webview, String> {
        let label = self
            .labels
            .lock()
            .map_err(|_| "browser surface lock poisoned".to_string())?
            .get(surface_id)
            .cloned()
            .unwrap_or_else(|| surface_label(surface_id));
        app.get_webview(&label)
            .ok_or_else(|| format!("browser surface {surface_id} has not been created"))
    }
}

fn surface_label(surface_id: &str) -> String {
    let safe = surface_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("browser-{safe}")
}

fn browser_engine() -> &'static str {
    #[cfg(target_os = "windows")]
    return "WebView2";
    #[cfg(target_os = "macos")]
    return "WKWebView";
    #[cfg(target_os = "linux")]
    return "WebKitGTK";
    #[allow(unreachable_code)]
    "system WebView"
}

fn parse_browser_url(value: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = value
        .parse()
        .map_err(|error| format!("invalid browser URL: {error}"))?;
    match url.scheme() {
        "http" | "https" | "about" => Ok(url),
        scheme => Err(format!("browser URL scheme is not allowed: {scheme}")),
    }
}
