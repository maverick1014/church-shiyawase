'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { useChurchScope } from '@/lib/church';
import {
  ErrorBanner,
  Field,
  Loading,
  SkeletonCard,
  SkeletonScreen,
  Switch,
  useConfirm,
  useToast,
} from '@/components/ui';
import { BrandLogo } from '@/components/BrandLogo';
import { ChurchProfile, ModuleStateRow } from '@/lib/types';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import { AccountRole } from '@tog/shared';

/**
 * 教会设置 — the church's own identity, and the catalog of add-on modules.
 *
 * Two things that used to be neither: the church was hardcoded in the frontend
 * and every module was always on. Both are data now, and both are edited here.
 *
 * CRUD (rule G1): the church record is READ + UPDATE only, deliberately — it
 * is a singleton seeded by migration 0012, one deployment serves one church,
 * and "delete the church" is not an operation this app should offer. Modules
 * are read + updated (on/off); the catalog itself is code, so a module cannot
 * be created or deleted from the UI either.
 *
 * super_admin-only, exactly like 用户管理 — and the API says the same for
 * every write to /church (rule G2).
 */
export default function ChurchSettingsPage() {
  const t = useT();
  const me = useMe();
  const router = useRouter();
  const isSuperAdmin = me.role === AccountRole.SuperAdmin;

  usePageChrome({ title: t('church.title') }, [t]);

  // Same treatment as 用户管理: anyone else who lands here by URL is sent to
  // their own profile rather than shown a page of refusals.
  useEffect(() => {
    if (!isSuperAdmin) router.replace('/profile');
  }, [isSuperAdmin, router]);

  const profile = useFetch<ChurchProfile>(isSuperAdmin ? '/church' : null);
  const modules = useFetch<ModuleStateRow[]>(isSuperAdmin ? '/church/modules' : null);

  if (!isSuperAdmin) return <Loading />;

  return (
    <div style={{ maxWidth: 720 }}>
      <ErrorBanner message={profile.error ?? modules.error} />

      {profile.initialLoading ? (
        <SkeletonScreen>
          <SkeletonCard lines={5} />
        </SkeletonScreen>
      ) : (
        profile.data && (
          <ChurchProfileCard
            // Remounts on a save so the form fields re-initialise from the
            // record that came back, instead of a second copy of the same
            // state being kept in sync by hand (rule G5).
            key={`${profile.data.name}|${profile.data.logo_url ?? ''}`}
            church={profile.data}
            onSaved={() => profile.reload()}
          />
        )
      )}

      <ModuleCatalog rows={modules.data ?? []} loading={modules.initialLoading} onChanged={() => modules.reload()} />
    </div>
  );
}

/** Name, short name, description and logo — the church's identity. */
function ChurchProfileCard({
  church,
  onSaved,
}: {
  church: ChurchProfile;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(church.name);
  const [shortName, setShortName] = useState(church.short_name ?? '');
  const [description, setDescription] = useState(church.description ?? '');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (!name.trim()) {
      setErr(t('church.err.name'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.patch('/church', {
        name: name.trim(),
        short_name: shortName.trim(),
        description: description.trim(),
      });
      onSaved();
      toast(t('church.toast.saved'));
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // The same upload path a member's photo takes (`api.upload` → a public
  // storage bucket → the URL onto the row), so there is one mechanism for
  // images rather than two (rule G4).
  const onPickLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.upload('/church/logo', fd);
      onSaved();
      toast(t('church.toast.logo'));
    } catch (err2) {
      setErr((err2 as Error).message);
      toast((err2 as Error).message, 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Discarding the uploaded mark is irreversible (the file is not kept
  // anywhere the UI can reach), so it asks first (rule G3).
  const removeLogo = async () => {
    const ok = await confirm({
      title: t('church.logo.remove.title'),
      message: t('church.logo.remove.message'),
      confirmText: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.patch('/church', { logo_url: null });
      onSaved();
      toast(t('church.toast.logoRemoved'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="card">
      <h3 style={{ marginBottom: 4 }}>{t('church.profile')}</h3>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 14 }}>{t('church.profileSub')}</div>
      {err && <ErrorBanner message={err} />}

      <div className="flex items-center gap-12 flex-wrap" style={{ marginBottom: 16 }}>
        <span
          style={{ width: 56, height: 56, borderRadius: 12, background: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)' }}
        >
          <BrandLogo size={46} church={church} />
        </span>
        <div className="flex items-center gap-8 flex-wrap">
          <button className="btn ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? t('church.logo.uploading') : church.logo_url ? t('church.logo.change') : t('church.logo.upload')}
          </button>
          {church.logo_url && (
            <button className="btn ghost" onClick={removeLogo}>{t('church.logo.remove')}</button>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickLogo} style={{ display: 'none' }} />
        </div>
      </div>

      <div className="form-row">
        <Field label={t('church.field.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('church.field.shortName')}>
          <input
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder={t('church.field.shortNamePlaceholder')}
          />
        </Field>
      </div>
      <div className="hint" style={{ marginBottom: 14 }}>{t('church.field.nameHint')}</div>
      <Field label={t('church.field.description')}>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <div className="flex-between flex-wrap mt-16">
        <div />
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? t('common.saving') : t('church.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * The add-on module catalog: one row per registry entry, with a switch.
 *
 * Turning one OFF removes a whole section of the app for everyone in the
 * church — the nav entry disappears and the API stops answering its paths — so
 * it goes through the shared confirm dialog with `danger` (rule G3), and the
 * message says both what goes away and what is kept.
 */
function ModuleCatalog({
  rows,
  loading,
  onChanged,
}: {
  rows: ModuleStateRow[];
  loading: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { reloadModules } = useChurchScope();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const toggle = async (row: ModuleStateRow) => {
    const name = t(`module.${row.key}.name` as MessageKey);
    if (row.enabled) {
      const ok = await confirm({
        title: t('church.modules.disable.title', { name }),
        message: (
          <>
            <p style={{ margin: '0 0 8px' }}>{t('church.modules.disable.message', { name })}</p>
            <p style={{ margin: 0 }}>{t(`module.${row.key}.dataKept` as MessageKey)}</p>
          </>
        ),
        confirmText: t('church.modules.disable.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    setBusyKey(row.key);
    try {
      await api.patch(`/church/modules/${row.key}`, { enabled: !row.enabled });
      onChanged();
      // The sidebar is drawn from the shell's own copy of these states, so it
      // has to be told too — otherwise the entry only goes on the next load.
      reloadModules();
      toast(row.enabled ? t('church.modules.toast.off', { name }) : t('church.modules.toast.on', { name }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="card mt-16">
      <h3 style={{ marginBottom: 4 }}>{t('church.modules')}</h3>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>{t('church.modulesSub')}</div>

      {loading ? (
        <SkeletonScreen>
          <SkeletonCard title={false} lines={2} style={{ border: 'none', padding: 0 }} />
        </SkeletonScreen>
      ) : (
        rows.map((row) => (
          <div
            key={row.key}
            className="flex-between"
            style={{ padding: '13px 0', borderBottom: '1px solid var(--border)', gap: 14 }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {t(`module.${row.key}.name` as MessageKey)}
              </div>
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                {t(`module.${row.key}.desc` as MessageKey)}
              </div>
            </div>
            <div className="flex items-center gap-10" style={{ flexShrink: 0 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {t(row.enabled ? 'common.enabled' : 'common.disabled')}
              </span>
              <Switch on={row.enabled} onToggle={busyKey === row.key ? undefined : () => toggle(row)} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
