'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';

interface EnrollTraining {
  id: string;
  name: string;
  category: string | null;
  is_enrollable: boolean;
  total_sessions: number;
}

type EnrollStatus = 'ok' | 'already' | 'no_member' | 'ambiguous' | 'closed';

// Friendly copy per outcome. `no_member` / `ambiguous` deliberately steer the
// visitor to the pastor rather than creating a member (avoids duplicates).
const RESULT: Record<EnrollStatus, { icon: string; tone: string; title: string; body: (name: string) => string }> = {
  ok: {
    icon: '✓',
    tone: 'var(--good)',
    title: '报名成功 🙏',
    body: (n) => `${n}，你的报名已提交，等待管理员审核通过。`,
  },
  already: {
    icon: 'ℹ',
    tone: 'var(--brand)',
    title: '你已经报名过了',
    body: (n) => `${n}，你先前已报名这门课程，无需重复报名。`,
  },
  no_member: {
    icon: '!',
    tone: 'var(--crit)',
    title: '未找到你的成员资料',
    body: () => '系统里没有与此姓名完全一致的成员资料。请联系牧师，将你加入教会成员系统后再报名。',
  },
  ambiguous: {
    icon: '!',
    tone: 'var(--crit)',
    title: '有多位同名成员',
    body: () => '系统里有多位成员同名，无法确认是你。请直接联系牧师协助报名。',
  },
  closed: {
    icon: '!',
    tone: 'var(--crit)',
    title: '暂未开放报名',
    body: () => '这门课程目前未开放报名。请联系牧师了解详情。',
  },
};

export default function EnrollFormPage() {
  const { id } = useParams<{ id: string }>();
  const [training, setTraining] = useState<EnrollTraining | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ status: EnrollStatus; name: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .get<EnrollTraining>(`/trainings/enroll/${id}`)
      .then((t) => {
        setTraining(t);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  const submit = async () => {
    if (!fullName.trim()) return;
    setSaving(true);
    try {
      const r = await api.post<{ status: EnrollStatus; name?: string }>(`/trainings/enroll/${id}`, {
        full_name: fullName.trim(),
      });
      setResult({ status: r.status, name: r.name ?? fullName.trim() });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--paper)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div className="flex-between" style={{ padding: '15px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 2 }}>
        <div className="flex items-center gap-10 serif" style={{ fontWeight: 600, fontSize: 15 }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)' }}>
            <BrandLogo size={26} />
          </span>
          培训课程 · 在线报名
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '26px 18px 44px' }}>
        <div className="card" style={{ width: '100%', maxWidth: 460 }}>
          {loading ? (
            <div className="loading">加载中…</div>
          ) : error ? (
            <div className="error-banner">⚠️ {error}</div>
          ) : result ? (
            <div style={{ textAlign: 'center', padding: '20px 6px' }}>
              <div style={{ width: 62, height: 62, borderRadius: '50%', background: 'var(--surface-2)', color: RESULT[result.status].tone, display: 'grid', placeItems: 'center', fontSize: 30, margin: '0 auto 14px' }}>
                {RESULT[result.status].icon}
              </div>
              <h3 className="serif" style={{ margin: '0 0 6px', fontSize: 18 }}>{RESULT[result.status].title}</h3>
              <p className="muted" style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.7 }}>
                {RESULT[result.status].body(result.name)}
              </p>
              {(result.status === 'no_member' || result.status === 'ambiguous') && (
                <button className="btn ghost" onClick={() => { setResult(null); setFullName(''); }}>重新填写</button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-8 flex-wrap" style={{ marginBottom: 4 }}>
                {training?.category && <span className="badge b-accent">{training.category}</span>}
                <strong className="serif" style={{ fontSize: 17 }}>{training?.name}</strong>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                共 {training?.total_sessions ?? 0} 场次 · 报名后等待管理员审核
              </div>

              {training && !training.is_enrollable ? (
                <div className="hint" style={{ marginTop: 14 }}>⚠️ 这门课程暂未开放报名。请联系牧师了解详情。</div>
              ) : (
                <>
                  <div className="field" style={{ marginTop: 16 }}>
                    <label className="field-label">完整中文姓名（务必与教会登记的姓名一致）</label>
                    <input
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="例如：陈约翰"
                      autoFocus
                    />
                  </div>
                  <div className="hint" style={{ marginBottom: 14 }}>
                    💡 我们会用你的<strong>完整中文姓名</strong>核对教会成员资料。若查无此人，请先联系牧师加入成员系统。
                  </div>
                  <button className="btn accent block" onClick={submit} disabled={saving || !fullName.trim()}>
                    {saving ? '提交中…' : '提交报名'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <div className="faint" style={{ marginTop: 18, fontSize: 12, textAlign: 'center', maxWidth: 460 }}>
          主恩堂 TABERNACLE OF GRACE
        </div>
      </div>
    </div>
  );
}
