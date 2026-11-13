import {
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_PERMISSION_MODES,
  CODEX_EFFORTS,
  type EnvReport,
  type SessionInfo,
  type ThemeMode,
  type Vendor,
} from '@agenthouse/protocol';
import { api, RequestError } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { CopyCommand } from './CopyCommand';

interface Props {
  open: boolean;
  env: EnvReport | null;
  /** Folders to offer: those of the sessions listed, the latest first. */
  folders: string[];
  mode: ThemeMode;
  onClose: () => void;
  onLaunched: (session: SessionInfo) => void;
}

const LAST_CWD_KEY = 'ah-last-cwd';

function readLastCwd(): string | null {
  try {
    return localStorage.getItem(LAST_CWD_KEY);
  } catch {
    return null;
  }
}

function installed(env: EnvReport | null, vendor: Vendor): boolean {
  return Boolean(env && env.clis[vendor].selected !== null);
}

export function LaunchDialog({ open, env, folders, mode, onClose, onLaunched }: Props) {
  const [vendor, setVendor] = useState<Vendor>('claude');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [error, setError] = useState<{ text: string; command?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setVendor(installed(env, 'claude') || !installed(env, 'codex') ? 'claude' : 'codex');
    setCwd((current) => current || readLastCwd() || env?.defaultCwd || '');
  }, [open, env]);

  const efforts = vendor === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  const missing = env !== null && !installed(env, vendor);
  const missingCommand = env?.messages.find((m) => m.id === `ENV_${vendor.toUpperCase()}_MISSING` || m.id === 'ENV_NO_CLI')?.command;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.launch({
        vendor,
        cwd: cwd.trim(),
        theme: mode,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
        ...(vendor === 'claude' && permissionMode ? { permissionMode } : {}),
      });
      try {
        localStorage.setItem(LAST_CWD_KEY, session.cwd);
      } catch {
        // per-browser convenience only
      }
      setTitle('');
      onLaunched(session);
      onClose();
    } catch (err) {
      const e = err as RequestError;
      setError({ text: e.message, ...(e.command ? { command: e.command } : {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="launch-title">
      <DialogTitle id="launch-title" sx={{ fontSize: 18, fontWeight: 600, pb: 1 }}>
        {t.launchTitle}
      </DialogTitle>
      {/* A form, so Enter in a field starts the session; it adds no box of its own to the dialog's layout. */}
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit().catch(() => {});
        }}
        sx={{ display: 'contents' }}
      >
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <ToggleButtonGroup
          exclusive
          fullWidth
          value={vendor}
          onChange={(_event, value: Vendor | null) => {
            if (!value) return;
            setVendor(value);
            setEffort('');
            setModel('');
          }}
          aria-label={t.cli}
          size="small"
        >
          {(['claude', 'codex'] as const).map((id) => {
            const status = env?.clis[id];
            const selected = status && status.selected !== null ? status.installs[status.selected] : undefined;
            return (
              <ToggleButton key={id} value={id} sx={{ flexDirection: 'column', gap: 0.25, py: 1, textTransform: 'none' }}>
                <span style={{ fontWeight: 500 }}>{t.vendorName[id]}</span>
                <span style={{ fontSize: 12, color: v.on2 }}>{status?.chosenError ? t.chosenUnusable : selected ? (selected.version ?? '') : env ? t.notInstalled : ''}</span>
              </ToggleButton>
            );
          })}
        </ToggleButtonGroup>
        {missing && missingCommand && <CopyCommand command={missingCommand} />}

        <TextField label={t.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''} size="small" />
        <Autocomplete
          freeSolo
          options={folders}
          inputValue={cwd}
          onInputChange={(_event, value) => setCwd(value)}
          renderInput={(params) => <TextField {...params} label={t.folder} size="small" required />}
          slotProps={{ listbox: { sx: { fontSize: 13, overflowWrap: 'anywhere' } } }}
        />
        <Autocomplete
          freeSolo
          options={vendor === 'claude' ? [...CLAUDE_MODEL_ALIASES] : []}
          inputValue={model}
          onInputChange={(_event, value) => setModel(value)}
          renderInput={(params) => <TextField {...params} label={t.model} placeholder={t.default} size="small" />}
        />
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <TextField select label={t.effort} value={effort} onChange={(e) => setEffort(e.target.value)} size="small" sx={{ flex: 1 }}>
            <MenuItem value="">{t.default}</MenuItem>
            {efforts.map((level) => (
              <MenuItem key={level} value={level}>
                {level}
              </MenuItem>
            ))}
          </TextField>
          {vendor === 'claude' && (
            <TextField select label={t.permissionMode} value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} size="small" sx={{ flex: 1 }}>
              <MenuItem value="">{t.default}</MenuItem>
              {CLAUDE_PERMISSION_MODES.map((m) => (
                <MenuItem key={m} value={m}>
                  {m}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Box>
        {error && (
          <Box role="alert" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.5, borderRadius: '10px', bgcolor: v.warnContainer, color: v.onWarnContainer }}>
            <Typography>{error.text}</Typography>
            {error.command && <CopyCommand command={error.command} />}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button type="button" onClick={onClose} color="inherit">
          {t.cancel}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || missing || !cwd.trim()}>
          {t.start}
        </Button>
      </DialogActions>
      </Box>
    </Dialog>
  );
}
