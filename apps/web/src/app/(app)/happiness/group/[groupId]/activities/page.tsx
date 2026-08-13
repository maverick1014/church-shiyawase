'use client';

import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  BackButton,
  ErrorBanner,
  Field,
  Modal,
  ModuleDisabled,
  PageBar,
  RoleRestricted,
  SkeletonCard,
  SkeletonScreen,
  useConfirm,
  useFormGuard,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { useModuleEnabled } from '@/lib/church';
import { compressImage } from '@/lib/imageCompress';
import { formatDate } from '@/lib/labels';
import { HappinessActivityRow, HappinessGroupDetail } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { AccountRole, MODULE_HAPPINESS } from '@tog/shared';

/**
 * 幸福小组活动记录 (0029) — what this group actually DID, evening by evening.
 *
 * The roll call next door answers "who came in week 5"; nothing answered "what
 * did we do", which is the half a leader wants back at the end of a term. So:
 * one record per date, a line about it, and as many photos as they want to put
 * on it.
 *
 * Records are dated rather than week-numbered — a group that met twice in a
 * week, or gathered outside the term, would have nowhere to put the second one,
 * and a photo is remembered by when it was taken.
 */
export default function HappinessActivitiesPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const perms = can(me.role);

  const happinessOn = useModuleEnabled(MODULE_HAPPINESS);
  const isGroupLeader = me.role === AccountRole.GroupLeader;
  const enabled = happinessOn && !isGroupLeader;
  const group = useFetch<HappinessGroupDetail>(enabled ? `/happiness/groups/${groupId}` : null);
  const activities = useFetch<HappinessActivityRow[]>(
    enabled ? `/happiness/groups/${groupId}/activities` : null,
  );

  const [form, setForm] = useState<HappinessActivityRow | 'new' | null>(null);

  usePageChrome({ title: t('happy.act.title') }, [t]);

  if (isGroupLeader) return <RoleRestricted />;
  if (!happinessOn) return <ModuleDisabled name={t('module.happiness.name')} />;

  const rows = activities.data ?? [];

  const remove = async (row: HappinessActivityRow) => {
    const ok = await confirm({
      title: t('happy.act.delete.title'),
      message: t('happy.act.delete.message', { date: formatDate(row.happened_on) }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/happiness/groups/${groupId}/activities/${row.id}`);
      activities.reload();
      toast(t('happy.act.toast.deleted'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <BackButton fallbackHref={`/happiness/group/${groupId}`} />
      <ErrorBanner message={group.error || activities.error} />

      <PageBar
        actions={
          perms.write ? (
            <button className="btn" onClick={() => setForm('new')}>{t('happy.act.add')}</button>
          ) : undefined
        }
      />

      {activities.initialLoading ? (
        <SkeletonScreen>
          {/* Two cards the shape a real record lands in, with the same gap
              between them, so the list does not jump when the fetch lands. */}
          <SkeletonCard lines={2} className="mb-16" />
          <SkeletonCard lines={2} />
        </SkeletonScreen>
      ) : rows.length === 0 ? (
        <div className="empty">{t('happy.act.empty')}</div>
      ) : (
        rows.map((row) => (
          <ActivityCard
            key={row.id}
            groupId={groupId}
            row={row}
            canWrite={perms.write}
            canDelete={perms.delete}
            onChanged={() => activities.reload()}
            onEdit={() => setForm(row)}
            onDelete={() => remove(row)}
          />
        ))
      )}

      {form && (
        <ActivityModal
          groupId={groupId}
          row={form === 'new' ? null : form}
          onClose={() => setForm(null)}
          onSaved={(created) => {
            setForm(null);
            activities.reload();
            toast(created ? t('happy.act.toast.created') : t('happy.act.toast.saved'));
          }}
        />
      )}
    </>
  );
}

/** One dated record: what happened, the note, and its photos. */
function ActivityCard({
  groupId,
  row,
  canWrite,
  canDelete,
  onChanged,
  onEdit,
  onDelete,
}: {
  groupId: string;
  row: HappinessActivityRow;
  canWrite: boolean;
  canDelete: boolean;
  onChanged: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const addPhoto = async (file: File) => {
    setBusy(true);
    try {
      // Compressed in the BROWSER first, like every other image this app takes
      // (rule G4): a phone camera photo routinely exceeds the server's own 5MB
      // cap, and this picker is pointed straight at the camera roll.
      const body = new FormData();
      body.append('file', await compressImage(file));
      await api.upload(`/happiness/groups/${groupId}/activities/${row.id}/photos`, body);
      onChanged();
      toast(t('happy.act.toast.photoAdded'));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removePhoto = async (url: string) => {
    const ok = await confirm({
      title: t('happy.act.removePhoto.title'),
      message: t('happy.act.removePhoto.message'),
      confirmText: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      // The whole list is written back, which is what a `text[]` column is for
      // — there is no per-photo row to delete.
      await api.patch(`/happiness/groups/${groupId}/activities/${row.id}`, {
        photo_urls: row.photo_urls.filter((u) => u !== url),
      });
      onChanged();
      toast(t('happy.act.toast.photoRemoved'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="card mb-16">
      <div className="card-head">
        <h3>{row.title || formatDate(row.happened_on)}</h3>
        <div className="flex gap-6">
          {canWrite && <button className="btn ghost sm" onClick={onEdit}>{t('common.edit')}</button>}
          {canDelete && (
            <button className="btn ghost sm" style={{ color: 'var(--crit)' }} onClick={onDelete}>
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>
      {/* The date is always its own line, even when it is also the heading:
          a record with a title still has to say when it happened. */}
      <div className="muted" style={{ fontSize: 12.5 }}>{formatDate(row.happened_on)}</div>
      {row.notes && <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{row.notes}</div>}

      {row.photo_urls.length > 0 && (
        <div className="photo-strip">
          {row.photo_urls.map((url) => (
            <div key={url} className="photo-thumb">
              {/* A plain <img>: these are Supabase public URLs on a host
                  next/image is not configured for, and the strip is already
                  size-bounded by CSS. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <a href={url} target="_blank" rel="noopener noreferrer">
                <img src={url} alt="" />
              </a>
              {canWrite && (
                <button
                  className="photo-thumb-x"
                  aria-label={t('happy.act.removePhoto')}
                  onClick={() => removePhoto(url)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="flex items-center gap-8" style={{ marginTop: 12 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void addPhoto(file);
            }}
          />
          <button className="btn ghost sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? t('happy.act.uploading') : t('happy.act.addPhoto')}
          </button>
          {row.photo_urls.length > 0 && (
            <span className="faint" style={{ fontSize: 12 }}>
              {t('happy.act.photoCount', { n: row.photo_urls.length })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityModal({
  groupId,
  row,
  onClose,
  onSaved,
}: {
  groupId: string;
  row: HappinessActivityRow | null;
  onClose: () => void;
  onSaved: (created: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [happenedOn, setHappenedOn] = useState(row?.happened_on ?? '');
  const [title, setTitle] = useState(row?.title ?? '');
  const [notes, setNotes] = useState(row?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { close } = useFormGuard({ happenedOn, title, notes }, onClose);

  const save = async () => {
    if (!happenedOn) {
      setErr(t('happy.act.err.date'));
      return;
    }
    setSaving(true);
    setErr(null);
    const dto = {
      happened_on: happenedOn,
      title: title.trim() || null,
      notes: notes.trim() || null,
    };
    try {
      if (row) {
        await api.patch(`/happiness/groups/${groupId}/activities/${row.id}`, dto);
        onSaved(false);
      } else {
        await api.post(`/happiness/groups/${groupId}/activities`, dto);
        onSaved(true);
      }
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={row ? t('happy.act.edit.title') : t('happy.act.new.title')} onClose={close}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('happy.act.field.date')}>
          <input
            type="date"
            className={happenedOn ? undefined : 'date-empty'}
            value={happenedOn}
            onChange={(e) => setHappenedOn(e.target.value)}
          />
        </Field>
        <Field label={t('happy.act.field.title')}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('happy.act.titlePlaceholder')}
          />
        </Field>
      </div>
      <Field label={t('happy.act.field.notes')}>
        <textarea
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('happy.act.notesPlaceholder')}
        />
      </Field>
      {/* Photos are added to a record that already EXISTS, from its own card —
          the same rule the add-member modal follows for an avatar, so nothing
          reaches storage attached to a row that was never saved. */}
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}
