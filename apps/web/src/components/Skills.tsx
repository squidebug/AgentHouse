import { Box, ButtonBase, Tooltip, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { SkillInfo } from '@agenthouse/protocol';
import { api } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { keySx } from './key';
import { NoteEditor } from './NoteEditor';

// Where a skill comes from, nearest first.
const SOURCES = ['project', 'user', 'plugin', 'builtin'] as const;

const mark = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
    <path d="M3.6 8.4 L6.6 11.2 L12.4 4.8" style={{ fill: 'none', stroke: v.done, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
  </svg>
);

const chip = { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: 28, px: '10px', borderRadius: '8px', fontSize: 12, lineHeight: '16px', overflowWrap: 'anywhere' } as const;

/**
 * The skills of a folder, by where they come from: read through one of its
 * sessions when the list is shown. The ones the folder's sessions ran are
 * marked; the project's and the user's own are keys that open their file to
 * edit, where a plugin's and the CLI's are plain names.
 */
export function SkillsList({ sessionId, used }: { sessionId: string; used: string[] }) {
  // undefined while they load, null when they could not be read.
  const [skills, setSkills] = useState<SkillInfo[] | null | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .skills(sessionId)
      .then((result) => live && setSkills(result.skills))
      .catch(() => live && setSkills(null));
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (skills === undefined) return <Typography sx={{ color: v.on2 }}>{t.loading}</Typography>;
  if (skills === null) return <Typography sx={{ color: v.on2 }}>{t.cannotShow}</Typography>;
  if (!skills.length) return <Typography sx={{ color: v.on2 }}>{t.noSkills}</Typography>;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {SOURCES.map((source) => {
        const group = skills.filter((skill) => skill.source === source);
        if (!group.length) return null;
        return (
          <Box key={source} role="group" aria-label={t.skillSource[source]} sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Typography sx={{ fontSize: 12, lineHeight: '16px', fontWeight: 500, color: v.on2 }}>
              {t.skillSource[source]} {group.length}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {group.map((skill) => {
                const ran = skill.used || used.includes(skill.name);
                const label = ran ? `${skill.name} ${t.skillUsed}` : skill.name;
                return (
                  <Tooltip key={skill.name} title={skill.about ?? ''}>
                    {skill.editable ? (
                      <ButtonBase aria-label={t.edit(label)} onClick={() => setEditing(skill.name)} sx={{ ...chip, ...keySx, fontWeight: ran ? 600 : 500 }}>
                        {ran && mark}
                        {skill.name}
                      </ButtonBase>
                    ) : (
                      <Box component="span" aria-label={ran ? label : undefined} sx={{ ...chip, bgcolor: v.surface2, fontWeight: ran ? 600 : 400 }}>
                        {ran && mark}
                        {skill.name}
                      </Box>
                    )}
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
        );
      })}
      {editing && (
        <NoteEditor
          title={editing}
          load={() => api.skillFile(sessionId, editing)}
          save={(text, version) => api.saveSkill(sessionId, editing, text, version)}
          onClose={() => setEditing(null)}
        />
      )}
    </Box>
  );
}
