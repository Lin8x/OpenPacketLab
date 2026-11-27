//! Native backup targets: folders and network shares, SFTP, FTP/FTPS, rclone, plus the secret
//! store and the OAuth loopback listener. Everything here is called from the web UI.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(what: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{what}: {e}")
}

// ------------------------------------------------------------------ secrets

fn secrets_path() -> Res<PathBuf> {
    let dir = dirs::config_dir()
        .ok_or("No configuration folder on this system")?
        .join("io.github.lin8x.openpacketlab");
    std::fs::create_dir_all(&dir).map_err(err("Creating the settings folder"))?;
    Ok(dir.join("secrets.json"))
}

#[tauri::command]
pub fn secrets_load() -> Res<HashMap<String, String>> {
    let p = secrets_path()?;
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(err("Reading saved credentials")),
        Err(_) => Ok(HashMap::new()),
    }
}

#[tauri::command]
pub fn secrets_save(secrets: HashMap<String, String>) -> Res<()> {
    let p = secrets_path()?;
    let tmp = p.with_extension("tmp");
    let data = serde_json::to_vec(&secrets).map_err(err("Saving credentials"))?;
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(err("Saving credentials"))?;
        f.write_all(&data).map_err(err("Saving credentials"))?;
    }
    std::fs::rename(&tmp, &p).map_err(err("Saving credentials"))
}

// ------------------------------------------------------------------ folders and shares

fn check_path(path: &str) -> Res<PathBuf> {
    if path.trim().is_empty() {
        return Err("Choose a folder first".into());
    }
    let p = PathBuf::from(path);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Paths may not contain “..”".into());
    }
    Ok(p)
}

#[tauri::command]
pub fn backup_folder_write(path: String, contents: String) -> Res<()> {
    let p = check_path(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(err("Creating the folder"))?;
    }
    let tmp = p.with_extension("partial");
    std::fs::write(&tmp, contents).map_err(err("Writing the backup"))?;
    std::fs::rename(&tmp, &p).map_err(err("Writing the backup"))
}

#[tauri::command]
pub fn backup_folder_list(path: String) -> Res<Vec<String>> {
    let p = check_path(&path)?;
    let Ok(rd) = std::fs::read_dir(&p) else {
        return Ok(vec![]);
    };
    Ok(rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub fn backup_folder_remove(path: String) -> Res<()> {
    let p = check_path(&path)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Deleting an old backup: {e}")),
    }
}

// ------------------------------------------------------------------ SFTP

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConn {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    fingerprint: Option<String>,
}

struct HostKeyCheck {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl russh::client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let data = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(c) => c.public_key().clone(),
        };
        let fp = data.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        *self.seen.lock().unwrap() = Some(fp.clone());
        // Trust on first use; afterwards the key must match what was recorded.
        Ok(match &self.expected {
            Some(e) if !e.is_empty() => *e == fp,
            _ => true,
        })
    }
}

async fn sftp_connect(c: &SftpConn) -> Res<(russh_sftp::client::SftpSession, String)> {
    let seen = Arc::new(Mutex::new(None));
    let handler = HostKeyCheck {
        expected: c.fingerprint.clone(),
        seen: seen.clone(),
    };
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let connect = russh::client::connect(config, (c.host.as_str(), c.port), handler);
    let mut session = match tokio::time::timeout(Duration::from_secs(20), connect).await {
        Err(_) => return Err(format!("Timed out connecting to {}", c.host)),
        Ok(Err(e)) => {
            let fp = seen.lock().unwrap().clone();
            return Err(match (fp, &c.fingerprint) {
                (Some(fp), Some(exp)) if !exp.is_empty() && fp != *exp => format!(
                    "The server's key changed (now {fp}, expected {exp}). If this is expected, clear the saved fingerprint."
                ),
                _ => format!("Connecting to {}: {e}", c.host),
            });
        }
        Ok(Ok(s)) => s,
    };
    let fingerprint = seen.lock().unwrap().clone().unwrap_or_default();

    let mut ok = false;
    if let Some(pem) = c.private_key.as_deref().filter(|k| !k.trim().is_empty()) {
        let key =
            russh::keys::decode_secret_key(pem, c.passphrase.as_deref().filter(|p| !p.is_empty()))
                .map_err(err("Reading the private key"))?;
        let hash = session
            .best_supported_rsa_hash()
            .await
            .map_err(err("Negotiating the key type"))?
            .flatten();
        let res = session
            .authenticate_publickey(
                &c.username,
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(err("Key authentication"))?;
        ok = res.success();
    }
    if !ok {
        if let Some(pw) = c.password.as_deref().filter(|p| !p.is_empty()) {
            ok = session
                .authenticate_password(&c.username, pw)
                .await
                .map_err(err("Password authentication"))?
                .success();
        }
    }
    if !ok {
        return Err("The server rejected the user name, password or key".into());
    }
    let channel = session
        .channel_open_session()
        .await
        .map_err(err("Opening an SSH channel"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(err("Starting SFTP"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(err("Starting SFTP"))?;
    Ok((sftp, fingerprint))
}

fn parent_dirs(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let mut out = vec![];
    let absolute = path.starts_with('/');
    for i in 1..parts.len() {
        let joined = parts[..i].join("/");
        out.push(if absolute {
            format!("/{joined}")
        } else {
            joined
        });
    }
    out
}

#[tauri::command]
pub async fn backup_sftp_test(conn: SftpConn) -> Res<String> {
    let (sftp, fp) = sftp_connect(&conn).await?;
    let _ = sftp.close().await;
    Ok(fp)
}

#[tauri::command]
pub async fn backup_sftp_put(conn: SftpConn, path: String, contents: String) -> Res<()> {
    use tokio::io::AsyncWriteExt;
    let (sftp, _) = sftp_connect(&conn).await?;
    for dir in parent_dirs(&path) {
        if !sftp.try_exists(dir.as_str()).await.unwrap_or(false) {
            sftp.create_dir(dir.as_str())
                .await
                .map_err(err("Creating a remote folder"))?;
        }
    }
    let mut f = sftp
        .create(path.as_str())
        .await
        .map_err(err("Creating the remote file"))?;
    f.write_all(contents.as_bytes())
        .await
        .map_err(err("Uploading"))?;
    f.shutdown().await.map_err(err("Uploading"))?;
    let _ = sftp.close().await;
    Ok(())
}

#[tauri::command]
pub async fn backup_sftp_list(conn: SftpConn, path: String) -> Res<Vec<String>> {
    let (sftp, _) = sftp_connect(&conn).await?;
    let names = match sftp.read_dir(path.as_str()).await {
        Ok(rd) => rd
            .filter(|e| !e.file_type().is_dir())
            .map(|e| e.file_name())
            .filter(|n| n != "." && n != "..")
            .collect(),
        Err(_) => vec![],
    };
    let _ = sftp.close().await;
    Ok(names)
}

#[tauri::command]
pub async fn backup_sftp_remove(conn: SftpConn, path: String) -> Res<()> {
    let (sftp, _) = sftp_connect(&conn).await?;
    sftp.remove_file(path.as_str())
        .await
        .map_err(err("Deleting an old backup"))?;
    let _ = sftp.close().await;
    Ok(())
}

// ------------------------------------------------------------------ FTP / FTPS

#[derive(Deserialize)]
pub struct FtpConn {
    host: String,
    port: u16,
    username: String,
    password: String,
    security: String,
}

fn tls_config() -> Arc<suppaftp::rustls::ClientConfig> {
    let roots =
        suppaftp::rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        suppaftp::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

fn ftp_connect(c: &FtpConn) -> Res<suppaftp::RustlsFtpStream> {
    use suppaftp::{RustlsConnector, RustlsFtpStream};
    let addr = format!("{}:{}", c.host, c.port);
    let mut ftp = match c.security.as_str() {
        "none" => RustlsFtpStream::connect(&addr).map_err(err("Connecting"))?,
        "implicit" => RustlsFtpStream::connect_secure_implicit(
            &addr,
            RustlsConnector::from(tls_config()),
            &c.host,
        )
        .map_err(err("Connecting with TLS"))?,
        _ => RustlsFtpStream::connect(&addr)
            .map_err(err("Connecting"))?
            .into_secure(RustlsConnector::from(tls_config()), &c.host)
            .map_err(err(
                "Starting TLS (choose “None” if the server has no FTPS)",
            ))?,
    };
    ftp.login(c.username.as_str(), c.password.as_str())
        .map_err(err("Logging in"))?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(err("Setting binary mode"))?;
    Ok(ftp)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_ftp_test(conn: FtpConn) -> Res<String> {
    blocking(move || {
        let mut ftp = ftp_connect(&conn)?;
        let pwd = ftp.pwd().unwrap_or_default();
        let _ = ftp.quit();
        Ok(format!(
            "Logged in{}.",
            if pwd.is_empty() {
                String::new()
            } else {
                format!(", home folder {pwd}")
            }
        ))
    })
    .await
}

#[tauri::command]
pub async fn backup_ftp_put(conn: FtpConn, path: String, contents: String) -> Res<()> {
    blocking(move || {
        let mut ftp = ftp_connect(&conn)?;
        for dir in parent_dirs(&path) {
            let _ = ftp.mkdir(&dir); // fails harmlessly when it exists
        }
        let mut reader = std::io::Cursor::new(contents.into_bytes());
        ftp.put_file(&path, &mut reader).map_err(err("Uploading"))?;
        let _ = ftp.quit();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn backup_ftp_list(conn: FtpConn, path: String) -> Res<Vec<String>> {
    blocking(move || {
        let mut ftp = ftp_connect(&conn)?;
        let dir = if path.is_empty() {
            None
        } else {
            Some(path.as_str())
        };
        let names = ftp
            .nlst(dir)
            .unwrap_or_default()
            .into_iter()
            .map(|n| n.rsplit('/').next().unwrap_or(&n).to_string())
            .collect();
        let _ = ftp.quit();
        Ok(names)
    })
    .await
}

#[tauri::command]
pub async fn backup_ftp_remove(conn: FtpConn, path: String) -> Res<()> {
    blocking(move || {
        let mut ftp = ftp_connect(&conn)?;
        ftp.rm(&path).map_err(err("Deleting an old backup"))?;
        let _ = ftp.quit();
        Ok(())
    })
    .await
}

// ------------------------------------------------------------------ rclone

fn rclone(binary: &str, args: &[&str], stdin: Option<&[u8]>) -> Res<String> {
    use std::process::{Command, Stdio};
    let bin = if binary.trim().is_empty() {
        "rclone"
    } else {
        binary.trim()
    };
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "rclone is not installed or not on PATH (https://rclone.org/install/)".to_string()
        } else {
            format!("Starting rclone: {e}")
        }
    })?;
    if let (Some(data), Some(mut si)) = (stdin, child.stdin.take()) {
        si.write_all(data).map_err(err("Sending data to rclone"))?;
    }
    let out = child.wait_with_output().map_err(err("Running rclone"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "rclone: {}",
            String::from_utf8_lossy(&out.stderr)
                .trim()
                .lines()
                .last()
                .unwrap_or("failed")
        ))
    }
}

#[tauri::command]
pub async fn backup_rclone_put(binary: String, target: String, contents: String) -> Res<()> {
    blocking(move || rclone(&binary, &["rcat", &target], Some(contents.as_bytes())).map(|_| ()))
        .await
}

#[tauri::command]
pub async fn backup_rclone_list(binary: String, target: String) -> Res<Vec<String>> {
    blocking(move || {
        Ok(rclone(&binary, &["lsf", "--files-only", &target], None)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn backup_rclone_remove(binary: String, target: String) -> Res<()> {
    blocking(move || rclone(&binary, &["deletefile", &target], None).map(|_| ())).await
}

#[tauri::command]
pub async fn backup_rclone_test(binary: String, target: String) -> Res<String> {
    blocking(move || {
        let version = rclone(&binary, &["version"], None)?;
        let remote = target.split(':').next().unwrap_or("").to_string() + ":";
        rclone(&binary, &["lsf", "--max-depth", "1", &remote], None)?;
        Ok(format!(
            "{} can reach {remote}",
            version.lines().next().unwrap_or("rclone")
        ))
    })
    .await
}

// ------------------------------------------------------------------ OAuth loopback

static LISTENERS: Mutex<Vec<(u16, TcpListener)>> = Mutex::new(Vec::new());

/// Starts listening for the OAuth redirect before the browser is opened.
#[tauri::command]
pub fn oauth_listen(port: u16) -> Res<()> {
    let mut l = LISTENERS.lock().unwrap();
    l.retain(|(p, _)| *p != port);
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Port {port} is busy, so sign-in cannot finish ({e}). Close other apps using it and retry."))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    l.push((port, listener));
    Ok(())
}

/// Waits for the browser to come back and returns the path and query it requested.
#[tauri::command]
pub async fn oauth_wait(port: u16, timeout_secs: u64) -> Res<String> {
    blocking(move || {
        let listener = {
            let mut l = LISTENERS.lock().unwrap();
            let i = l.iter().position(|(p, _)| *p == port).ok_or("Sign-in was not started")?;
            l.remove(i).1
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).ok();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let target = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();
                    if target.starts_with("/favicon") {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                        continue;
                    }
                    let body = "<!doctype html><meta charset=utf-8><title>OpenPacketLab</title><body style=\"font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh\"><p>You're signed in. You can close this tab and return to OpenPacketLab.</p>";
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    );
                    return Ok(target);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        return Err("Sign-in timed out".into());
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Integration tests against local servers: `OPL_IT=1 cargo test -- --ignored`
    //! SFTP on 127.0.0.1:2222 (user opl/oplpass, folder upload), FTP on 127.0.0.1:2121.
    use super::*;

    fn sftp() -> SftpConn {
        SftpConn {
            host: "127.0.0.1".into(),
            port: 2222,
            username: "opl".into(),
            password: Some("oplpass".into()),
            private_key: None,
            passphrase: None,
            fingerprint: None,
        }
    }

    fn ftp() -> FtpConn {
        FtpConn {
            host: "127.0.0.1".into(),
            port: 2121,
            username: "opl".into(),
            password: "oplpass".into(),
            security: "none".into(),
        }
    }

    #[test]
    fn parent_dirs_split() {
        assert_eq!(parent_dirs("a/b/c.opl"), vec!["a", "a/b"]);
        assert_eq!(parent_dirs("/x/y.opl"), vec!["/x"]);
        assert!(parent_dirs("c.opl").is_empty());
    }

    #[test]
    fn folder_round_trip() {
        let dir = std::env::temp_dir().join(format!("opl-test-{}", std::process::id()));
        let file = dir.join("Lab/Lab_1.opl");
        backup_folder_write(file.to_string_lossy().into(), "{}".into()).unwrap();
        let names = backup_folder_list(dir.join("Lab").to_string_lossy().into()).unwrap();
        assert_eq!(names, vec!["Lab_1.opl"]);
        backup_folder_remove(file.to_string_lossy().into()).unwrap();
        assert!(backup_folder_list(dir.join("Lab").to_string_lossy().into())
            .unwrap()
            .is_empty());
        assert!(backup_folder_write(dir.join("../x").to_string_lossy().into(), "".into()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore]
    fn sftp_round_trip() {
        tauri::async_runtime::block_on(async {
            let fp = backup_sftp_test(sftp()).await.unwrap();
            assert!(fp.starts_with("SHA256:"));
            backup_sftp_put(sftp(), "upload/it/Lab_1.opl".into(), "{\"a\":1}".into())
                .await
                .unwrap();
            let names = backup_sftp_list(sftp(), "upload/it".into()).await.unwrap();
            assert!(names.contains(&"Lab_1.opl".to_string()));
            backup_sftp_remove(sftp(), "upload/it/Lab_1.opl".into())
                .await
                .unwrap();
            let mut wrong = sftp();
            wrong.fingerprint = Some("SHA256:not-the-key".into());
            assert!(backup_sftp_test(wrong)
                .await
                .unwrap_err()
                .contains("key changed"));
            let mut bad = sftp();
            bad.password = Some("nope".into());
            assert!(backup_sftp_test(bad).await.is_err());
        });
    }

    #[test]
    #[ignore]
    fn ftp_round_trip() {
        tauri::async_runtime::block_on(async {
            backup_ftp_test(ftp()).await.unwrap();
            backup_ftp_put(ftp(), "it/Lab_1.opl".into(), "{\"a\":1}".into())
                .await
                .unwrap();
            let names = backup_ftp_list(ftp(), "it".into()).await.unwrap();
            assert!(names.contains(&"Lab_1.opl".to_string()), "{names:?}");
            backup_ftp_remove(ftp(), "it/Lab_1.opl".into())
                .await
                .unwrap();
        });
    }
}
