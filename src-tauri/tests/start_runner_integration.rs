use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::events::{NoopEmitter, NoopNotifier};
use cc_panes_core::models::{CliTool, LaunchProviderSelection, RunnerProfileDraft};
use cc_panes_core::repository::{Database, RunnerRepository};
use cc_panes_core::services::{
    ProcessMonitorService, ProjectCliHooksService, ProviderService, RunnerService, SettingsService,
    SshCredentialService, TerminalService,
};
use cc_panes_core::utils::AppPaths;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

fn platform_sleep_command() -> String {
    if cfg!(target_os = "windows") {
        // Six loopback pings take about five seconds. Avoid cold PowerShell startup
        // and its console probing on headless Windows CI; no external host is used.
        "ping.exe -n 6 127.0.0.1 >nul & exit /b 0".to_string()
    } else {
        "sleep 5; exit".to_string()
    }
}

fn make_services(temp_dir: &tempfile::TempDir) -> (Arc<TerminalService>, RunnerService) {
    let app_paths = Arc::new(AppPaths::new(Some(
        temp_dir.path().join("app-data").display().to_string(),
    )));
    let settings = Arc::new(SettingsService::new_with_config_path(
        temp_dir.path().join("config.toml"),
    ));
    let mut config = settings.get_settings();
    config.terminal.shell = Some(if cfg!(windows) { "cmd" } else { "/bin/sh" }.into());
    settings
        .update_settings(config)
        .expect("isolated runner settings");
    let provider = Arc::new(ProviderService::new(temp_dir.path().join("providers.json")));
    let cli_registry = Arc::new(CliToolRegistry::new());
    let hooks = Arc::new(ProjectCliHooksService::new(cli_registry.clone()));
    let ssh_credentials = Arc::new(SshCredentialService::new());
    let terminal = Arc::new(TerminalService::new(
        settings,
        provider,
        app_paths,
        cli_registry,
        hooks,
        ssh_credentials,
    ));
    terminal.set_emitter(Arc::new(NoopEmitter));
    terminal.set_notifier(Arc::new(NoopNotifier));

    let db = Arc::new(Database::new_fallback().expect("in-memory db"));
    let repo = Arc::new(RunnerRepository::new(db));
    let runner = RunnerService::new(repo, Arc::new(ProcessMonitorService::new()));
    (terminal, runner)
}

async fn wait_for_session_pid(terminal: &TerminalService, session_id: &str) -> u32 {
    for _ in 0..20 {
        if let Some(pid) = terminal
            .get_all_status()
            .expect("status")
            .into_iter()
            .find(|status| status.session_id == session_id)
            .and_then(|status| status.pid)
        {
            return pid;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("session pid not resolved for {session_id}");
}

async fn wait_for_session_exit(terminal: &TerminalService, session_id: &str) {
    for _ in 0..200 {
        // Natural exits move out of the live list after their output is drained.
        // The per-session endpoint retains the real exit status in dead_buffers.
        if let Some(status) = terminal
            .get_session_status(session_id)
            .expect("session status")
        {
            if status.status.is_terminal() {
                assert_eq!(status.exit_code, Some(0), "runner must exit naturally");
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let output = terminal
        .get_session_replay_snapshot(session_id)
        .map(|snapshot| format!("{snapshot:?}"))
        .unwrap_or_else(|error| format!("failed to read output: {error}"));
    let _ = terminal.kill(session_id);
    panic!("session did not exit: {session_id}\n{output}");
}

async fn submit_shell_command(terminal: &TerminalService, session_id: &str, command: &str) {
    // A process id exists before ConPTY/cmd has installed its input handlers.
    // Wait for the actual prompt, not an arbitrary delay or a replayed Enter.
    #[cfg(windows)]
    {
        let mut ready = false;
        for _ in 0..200 {
            // The line API can omit the current unterminated prompt; raw replay includes it.
            let output = terminal
                .get_session_replay_snapshot(session_id)
                .expect("shell output");
            if output.is_some_and(|snapshot| snapshot.data.contains('>')) {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            ready,
            "fixture shell must display its prompt before submission"
        );
    }
    terminal
        .submit_text_to_session(session_id, command)
        .expect("submit shell command");
}

#[tokio::test]
async fn start_runner_components_launch_reuse_exit_and_relaunch_sleep_command() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let project_dir = temp_dir.path().join("project");
    std::fs::create_dir_all(&project_dir).expect("project dir");
    let (terminal, runner) = make_services(&temp_dir);

    let profile = runner
        .upsert_profile(RunnerProfileDraft {
            id: None,
            project_path: project_dir.display().to_string(),
            workspace_name: Some("integration-ws".to_string()),
            name: "sleep".to_string(),
            command: platform_sleep_command(),
            cwd: project_dir.display().to_string(),
            runtime_kind: "local".to_string(),
            wsl_distro: None,
            ssh_machine_id: None,
            env: HashMap::new(),
            expected_ports: vec![],
            tool_hint: Some("sh".to_string()),
        })
        .expect("profile");

    let session_id = terminal
        .create_session(
            None,
            &profile.cwd,
            120,
            30,
            profile.workspace_name.as_deref(),
            None,
            None,
            LaunchProviderSelection::None,
            None,
            None,
            None,
            CliTool::None,
            None,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("create session");
    let root_pid = wait_for_session_pid(&terminal, &session_id).await;
    let instance = runner
        .register_instance(
            Some(&profile.id),
            &profile.project_path,
            profile.workspace_name.as_deref(),
            Some(&session_id),
            root_pid,
            "local",
            &profile.command,
            &profile.cwd,
        )
        .expect("register");
    submit_shell_command(&terminal, &session_id, &profile.command).await;

    let active = runner
        .list_active_by_profile(&profile.id)
        .expect("active after launch");
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, instance.id);
    assert_eq!(active[0].session_id.as_deref(), Some(session_id.as_str()));

    let reused = runner
        .list_active_by_profile(&profile.id)
        .expect("active reused")
        .into_iter()
        .find(|candidate| {
            candidate.session_id.as_deref() == Some(session_id.as_str())
                && terminal
                    .get_all_status()
                    .expect("status")
                    .iter()
                    .any(|status| {
                        status.session_id == session_id
                            && status.pid == Some(candidate.root_pid)
                            && !status.status.is_terminal()
                    })
        });
    assert!(
        reused.is_some(),
        "same profile should be reusable while alive"
    );

    wait_for_session_exit(&terminal, &session_id).await;
    assert!(
        runner
            .mark_exited_by_session(&session_id, None)
            .expect("mark exited"),
        "runner instance should be marked by session id"
    );
    assert!(runner
        .list_active_by_profile(&profile.id)
        .expect("active after exit")
        .is_empty());

    let relaunch_session_id = terminal
        .create_session(
            None,
            &profile.cwd,
            120,
            30,
            profile.workspace_name.as_deref(),
            None,
            None,
            LaunchProviderSelection::None,
            None,
            None,
            None,
            CliTool::None,
            None,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("relaunch session");
    let relaunch_pid = wait_for_session_pid(&terminal, &relaunch_session_id).await;
    let relaunched = runner
        .register_instance(
            Some(&profile.id),
            &profile.project_path,
            profile.workspace_name.as_deref(),
            Some(&relaunch_session_id),
            relaunch_pid,
            "local",
            &profile.command,
            &profile.cwd,
        )
        .expect("register relaunch");
    assert_ne!(relaunched.id, instance.id);
    terminal
        .kill(&relaunch_session_id)
        .expect("cleanup relaunch");
}
