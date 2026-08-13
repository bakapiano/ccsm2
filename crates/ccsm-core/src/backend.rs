use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use crate::{
    dto::{
        AgentActivity, AgentActivityChangedDto, AgentSummaryDto, AppEvent, BootstrapDto,
        CliSessionDto, CreateBrowserTabRequest, CreateCliTabRequest, CreateFileEditorTabRequest,
        CreateFileExplorerTabRequest, CreateFolderRequest, CreateGitTabRequest, CreateSpaceRequest,
        CreatedCliTabDto, DeleteFolderRequest, DeleteSpaceRequest, DeleteTabRequest, DesiredState,
        DirectoryListingDto, FileDocumentDto, GitSnapshotDto, HookReport, ListDirectoryRequest,
        MoveFolderRequest, MoveSpaceRequest, NativeBindingDto, NativeBindingState, ReadFileRequest,
        RefreshGitRequest, RenameFolderRequest, RenameSpaceRequest, ResolveFileReferenceRequest,
        ResolvedFileReferenceDto, RuntimeEvent, RuntimeStartedDto, SaveLayoutRequest,
        SetFolderCollapsedRequest, SpaceLayoutDto, SpaceSnapshotDto, StartRuntimeRequest, TabDto,
        TabKind, UpdateTabStateRequest, WriteFileRequest, WriteFileResultDto,
    },
    error::{BackendError, BackendResult},
    ports::{FileSystemBackend, FileWatchBackend, GitBackend, PtyBackend, StateStore},
    root::{ActiveRootContext, AppEventSink},
    runtime::{HookTransportDescriptor, RuntimeEventSink, RuntimeManager},
};

pub struct AppBackend {
    store: Arc<dyn StateStore>,
    runtimes: Arc<RuntimeManager>,
    root_context: ActiveRootContext,
    event_sink: AppEventSink,
    hook_transport: Mutex<Option<HookTransportDescriptor>>,
}

impl AppBackend {
    pub fn new(
        store: Arc<dyn StateStore>,
        pty_backend: Arc<dyn PtyBackend>,
        filesystem: Arc<dyn FileSystemBackend>,
        git: Arc<dyn GitBackend>,
        file_watch: Arc<dyn FileWatchBackend>,
        event_sink: AppEventSink,
    ) -> Arc<Self> {
        Arc::new(Self {
            root_context: ActiveRootContext::new(
                Arc::clone(&store),
                filesystem,
                git,
                file_watch,
                Arc::clone(&event_sink),
            ),
            store,
            runtimes: RuntimeManager::new(pty_backend),
            event_sink,
            hook_transport: Mutex::new(None),
        })
    }

    pub fn configure_hook_transport(
        &self,
        descriptor: HookTransportDescriptor,
    ) -> BackendResult<()> {
        *self
            .hook_transport
            .lock()
            .map_err(|_| BackendError::Platform("Hook transport lock poisoned".into()))? =
            Some(descriptor);
        Ok(())
    }

    pub fn bootstrap(&self, default_root: &Path) -> BackendResult<BootstrapDto> {
        let state = self.store.bootstrap(default_root)?;
        self.root_context.activate(&state.active_space_id)?;
        Ok(state)
    }

    pub fn load_space(&self, space_id: &str) -> BackendResult<SpaceSnapshotDto> {
        self.store.load_space(space_id)
    }

    pub fn switch_space(&self, space_id: &str) -> BackendResult<BootstrapDto> {
        let state = self.store.switch_space(space_id)?;
        self.root_context.activate(&state.active_space_id)?;
        Ok(state)
    }

    pub fn create_space(&self, request: CreateSpaceRequest) -> BackendResult<BootstrapDto> {
        let state = self.store.create_space(request)?;
        self.root_context.activate(&state.active_space_id)?;
        Ok(state)
    }

    pub fn rename_space(&self, request: RenameSpaceRequest) -> BackendResult<BootstrapDto> {
        self.store.rename_space(request)
    }

    pub fn delete_space(&self, request: DeleteSpaceRequest) -> BackendResult<BootstrapDto> {
        for session_id in self.store.cli_session_ids_for_space(&request.space_id)? {
            self.runtimes.stop_session(&session_id)?;
        }
        let state = self.store.delete_space(request)?;
        self.root_context.activate(&state.active_space_id)?;
        Ok(state)
    }

    pub fn create_folder(&self, request: CreateFolderRequest) -> BackendResult<BootstrapDto> {
        self.store.create_folder(request)
    }

    pub fn rename_folder(&self, request: RenameFolderRequest) -> BackendResult<BootstrapDto> {
        self.store.rename_folder(request)
    }

    pub fn set_folder_collapsed(
        &self,
        request: SetFolderCollapsedRequest,
    ) -> BackendResult<BootstrapDto> {
        self.store.set_folder_collapsed(request)
    }

    pub fn delete_folder(&self, request: DeleteFolderRequest) -> BackendResult<BootstrapDto> {
        self.store.delete_folder(request)
    }

    pub fn move_space(&self, request: MoveSpaceRequest) -> BackendResult<BootstrapDto> {
        self.store.move_space(request)
    }

    pub fn move_folder(&self, request: MoveFolderRequest) -> BackendResult<BootstrapDto> {
        self.store.move_folder(request)
    }

    pub fn save_layout(&self, request: SaveLayoutRequest) -> BackendResult<SpaceLayoutDto> {
        self.store.save_layout(request)
    }

    pub fn update_tab_state(&self, request: UpdateTabStateRequest) -> BackendResult<TabDto> {
        self.store.update_tab_state(request)
    }

    pub fn delete_tab(&self, request: DeleteTabRequest) -> BackendResult<TabDto> {
        let active = self.store.workspace_state()?.active_space_id;
        if request.space_id != active {
            return Err(BackendError::Conflict(
                "Tabs can only be deleted from the active Space".into(),
            ));
        }
        let tab = self.store.get_tab(&request.tab_id)?;
        if tab.space_id != request.space_id {
            return Err(BackendError::Conflict(
                "Tab does not belong to the requested Space".into(),
            ));
        }
        if tab.kind == TabKind::CliSession
            && let Some(session_id) = tab.resource_id.as_deref()
        {
            self.runtimes.stop_session(session_id)?;
        }
        self.store.delete_tab(request)
    }

    pub fn create_cli_tab(&self, request: CreateCliTabRequest) -> BackendResult<CreatedCliTabDto> {
        let active = self.store.workspace_state()?.active_space_id;
        if request.space_id != active {
            return Err(BackendError::Conflict(
                "CLI Tabs can only be created in the active Space".into(),
            ));
        }
        self.store.create_cli_tab(request)
    }

    pub fn create_browser_tab(&self, request: CreateBrowserTabRequest) -> BackendResult<TabDto> {
        let active = self.store.workspace_state()?.active_space_id;
        if request.space_id != active {
            return Err(BackendError::Conflict(
                "Browser Tabs can only be created in the active Space".into(),
            ));
        }
        self.store.create_browser_tab(request)
    }

    pub fn create_file_explorer_tab(
        &self,
        request: CreateFileExplorerTabRequest,
    ) -> BackendResult<TabDto> {
        let active = self.store.workspace_state()?.active_space_id;
        if request.space_id != active {
            return Err(BackendError::Conflict(
                "File Explorer Tabs can only be created in the active Space".into(),
            ));
        }
        self.store.create_file_explorer_tab(request)
    }

    pub fn create_file_editor_tab(
        &self,
        request: CreateFileEditorTabRequest,
    ) -> BackendResult<TabDto> {
        let active = self.store.workspace_state()?.active_space_id;
        if request.space_id != active {
            return Err(BackendError::Conflict(
                "File Editor Tabs can only be created in the active Space".into(),
            ));
        }
        self.store.create_file_editor_tab(request)
    }

    pub fn create_git_tab(&self, request: CreateGitTabRequest) -> BackendResult<TabDto> {
        let active = self.store.workspace_state()?.active_space_id;
        if request.space_id != active {
            return Err(BackendError::Conflict(
                "Git Tabs can only be created in the active Space".into(),
            ));
        }
        self.store.create_git_tab(request)
    }

    pub fn get_cli_session(&self, session_id: &str) -> BackendResult<CliSessionDto> {
        self.store.get_cli_session(session_id)
    }

    pub fn list_agents(&self) -> BackendResult<Vec<AgentSummaryDto>> {
        let mut agents = self.store.list_agents()?;
        for agent in &mut agents {
            if let Some((runtime_id, activity)) =
                self.runtimes.agent_activity(&agent.cli_session_id)?
            {
                agent.runtime_id = Some(runtime_id);
                agent.activity = activity;
            }
        }
        Ok(agents)
    }

    pub fn replace_cli_session(&self, session_id: &str) -> BackendResult<CliSessionDto> {
        if self.runtimes.has_session(session_id)? {
            return Err(BackendError::Conflict(
                "stop the current runtime before replacing its native Session".into(),
            ));
        }
        self.store.reset_cli_session_binding(session_id)
    }

    pub fn list_directory(
        &self,
        request: ListDirectoryRequest,
    ) -> BackendResult<DirectoryListingDto> {
        self.root_context.list_directory(request)
    }

    pub fn read_file(&self, request: ReadFileRequest) -> BackendResult<FileDocumentDto> {
        self.root_context.read_file(request)
    }

    pub fn resolve_file_reference(
        &self,
        request: ResolveFileReferenceRequest,
    ) -> BackendResult<ResolvedFileReferenceDto> {
        self.root_context.resolve_file_reference(request)
    }

    pub fn write_file(&self, request: WriteFileRequest) -> BackendResult<WriteFileResultDto> {
        self.root_context.write_file(request)
    }

    pub fn cached_git(&self, space_id: &str) -> BackendResult<GitSnapshotDto> {
        self.root_context.cached_git(space_id)
    }

    pub fn refresh_git(&self, request: RefreshGitRequest) -> BackendResult<GitSnapshotDto> {
        self.root_context.refresh_git(request)
    }

    pub fn start_runtime(
        self: &Arc<Self>,
        request: StartRuntimeRequest,
        sink: RuntimeEventSink,
    ) -> BackendResult<RuntimeStartedDto> {
        let session = self.store.get_cli_session(&request.cli_session_id)?;
        if session.provider != crate::dto::ProviderKind::Shell
            && session.native_binding_state == NativeBindingState::Unavailable
        {
            return Err(BackendError::Invalid(
                "native Session binding is unavailable; use Start New / Replace".into(),
            ));
        }
        self.store
            .set_desired_state(&session.id, DesiredState::Running)?;
        let hook_transport = self
            .hook_transport
            .lock()
            .map_err(|_| BackendError::Platform("Hook transport lock poisoned".into()))?
            .clone();
        let lifecycle_session_id = session.id.clone();
        let lifecycle_provider = session.provider;
        let store = Arc::clone(&self.store);
        let event_sink = Arc::clone(&self.event_sink);
        let lifecycle_sink: RuntimeEventSink = Arc::new(move |event| {
            if let RuntimeEvent::Exit { runtime_id, .. } = &event {
                if lifecycle_provider != crate::dto::ProviderKind::Shell {
                    event_sink(activity_event(AgentActivityChangedDto {
                        cli_session_id: lifecycle_session_id.clone(),
                        runtime_id: runtime_id.clone(),
                        activity: AgentActivity::Stopped,
                    }));
                }
                if let Ok(Some(updated)) =
                    store.mark_binding_unavailable_if_pending(&lifecycle_session_id)
                {
                    event_sink(binding_event(&updated));
                }
            }
            sink(event);
        });
        let started = self.runtimes.start_session(
            session,
            request.cols,
            request.rows,
            hook_transport,
            lifecycle_sink,
        )?;
        if lifecycle_provider != crate::dto::ProviderKind::Shell
            && let Some((runtime_id, activity)) =
                self.runtimes.agent_activity(&started.cli_session_id)?
        {
            (self.event_sink)(activity_event(AgentActivityChangedDto {
                cli_session_id: started.cli_session_id.clone(),
                runtime_id,
                activity,
            }));
        }
        Ok(started)
    }

    pub fn report_hook(&self, report: HookReport) -> BackendResult<CliSessionDto> {
        let validated = self.runtimes.apply_hook_report(&report)?;
        let binding = validated.binding;
        let previous = self.store.get_cli_session(&binding.cli_session_id)?;
        let session = self.store.bind_native_session(
            &binding.cli_session_id,
            binding.provider,
            &binding.native_session_id,
        )?;
        if previous.native_session_id != session.native_session_id
            || previous.native_binding_state != session.native_binding_state
        {
            (self.event_sink)(binding_event(&session));
        }
        if let Some(activity) = validated.activity_changed {
            (self.event_sink)(activity_event(activity));
        }
        Ok(session)
    }

    pub fn write_runtime(&self, runtime_id: &str, data: Vec<u8>) -> BackendResult<()> {
        self.runtimes.write(runtime_id, data)
    }

    pub fn resize_runtime(&self, runtime_id: &str, cols: u16, rows: u16) -> BackendResult<()> {
        self.runtimes.resize(runtime_id, cols, rows)
    }

    pub fn stop_runtime(&self, runtime_id: &str) -> BackendResult<()> {
        let session_id = self.runtimes.stop(runtime_id)?;
        self.store
            .set_desired_state(&session_id, DesiredState::Stopped)
    }

    pub fn shutdown(&self) {
        self.runtimes.shutdown();
        self.root_context.shutdown();
    }
}

fn binding_event(session: &CliSessionDto) -> AppEvent {
    AppEvent::SessionBindingChanged {
        payload: NativeBindingDto {
            cli_session_id: session.id.clone(),
            provider: session.provider,
            native_session_id: session.native_session_id.clone(),
            native_binding_state: session.native_binding_state,
        },
    }
}

fn activity_event(payload: AgentActivityChangedDto) -> AppEvent {
    AppEvent::AgentActivityChanged { payload }
}
