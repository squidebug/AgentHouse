import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, TextField, Typography } from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';
import type { CliStatus, EnvReport, Vendor } from '@agenthouse/protocol';
import { api } from '../api/client';
import { chosenPath, CUSTOM, firstOnPath, initialChoice, SHELL } from '../cli-choice';
import { t } from '../strings';
import { FONT_MONO } from '../theme/theme';
import { v } from '../theme/tokens';

const VENDORS = ['claude', 'codex'] as const;

/** Each CLI: the version it runs (or why none), the file, and 변경. */
export function CliRows({ env, onChange }: { env: EnvReport; onChange: (vendor: Vendor) => void }) {
  return (
    <>
      {VENDORS.map((vendor) => {
        const status = env.clis[vendor];
        const install = status.selected === null ? undefined : status.installs[status.selected];
        const state = status.chosenError ? t.chosenUnusable : install ? [install.version ?? '?', status.chosen ? t.chosen : null].filter(Boolean).join(' · ') : t.notInstalled;
        const file = status.chosenError ? status.chosen : install?.shim;
        return (
          <Box key={vendor} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 13 }}>
                {t.vendorName[vendor]}{' '}
                <Box component="span" sx={{ color: status.chosenError ? v.error : v.on2 }}>
                  {state}
                </Box>
              </Typography>
              {file && <Typography sx={{ fontSize: 12, color: v.on2, fontFamily: FONT_MONO, overflowWrap: 'anywhere' }}>{file}</Typography>}
            </Box>
            <Button size="small" onClick={() => onChange(vendor)} aria-label={`${t.vendorName[vendor]} ${t.executable} ${t.change}`} sx={{ flex: 'none', minWidth: 0 }}>
              {t.change}
            </Button>
          </Box>
        );
      })}
    </>
  );
}

function Choice({ value, label, detail }: { value: string; label: string; detail?: ReactNode }) {
  return (
    <FormControlLabel
      value={value}
      control={<Radio size="small" />}
      sx={{ alignItems: 'flex-start', mr: 0, '& .MuiRadio-root': { pt: '6px' } }}
      label={
        <Box sx={{ py: '7px' }}>
          <Typography sx={{ fontSize: 13 }}>{label}</Typography>
          {detail && <Typography sx={{ fontSize: 12, color: v.on2, fontFamily: FONT_MONO, overflowWrap: 'anywhere' }}>{detail}</Typography>}
        </Box>
      }
    />
  );
}

/** Picks the executable a CLI runs: the shell's, another on PATH, or a file typed in; the server runs it to check before saving. */
export function CliDialog({ status, onClose, onSaved }: { status: CliStatus | null; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(SHELL);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!status) return;
    const start = initialChoice(status);
    setValue(start.value);
    setCustom(start.custom);
    setError(status.chosenError ?? null);
  }, [status]);

  if (!status) return null;
  const name = t.vendorName[status.vendor];
  const first = status.installs[firstOnPath(status)];
  const others = status.installs.map((install, index) => ({ install, index })).filter(({ install, index }) => install.onPath && index !== firstOnPath(status));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.chooseCli(status.vendor, chosenPath(status, value, custom));
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="cli-title">
      <DialogTitle id="cli-title" sx={{ fontSize: 18, fontWeight: 600, pb: 1 }}>{`${name} ${t.executable}`}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <RadioGroup value={value} onChange={(event) => setValue(event.target.value)} aria-label={`${name} ${t.executable}`}>
          <Choice value={SHELL} label={t.shellDefault} detail={first ? `${first.version ?? '?'} · ${first.shim}` : t.none} />
          {others.map(({ install, index }) => (
            <Choice key={index} value={`install:${index}`} label={install.version ?? '?'} detail={install.shim} />
          ))}
          <Choice value={CUSTOM} label={t.chooseFile} />
        </RadioGroup>
        <TextField
          value={custom}
          onChange={(event) => {
            setCustom(event.target.value);
            setValue(CUSTOM);
          }}
          onFocus={() => setValue(CUSTOM)}
          placeholder={t.fullPath}
          size="small"
          fullWidth
          slotProps={{ htmlInput: { 'aria-label': t.fullPath, spellCheck: false } }}
          sx={{ ml: 4, width: 'calc(100% - 32px)', '& input': { fontFamily: FONT_MONO, fontSize: 12 } }}
        />
        {error && <Typography sx={{ color: v.error, fontSize: 12, ml: 4 }}>{error}</Typography>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{t.cancel}</Button>
        <Button variant="contained" disableElevation onClick={save} disabled={busy || (value === CUSTOM && !custom.trim())}>
          {t.save}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
