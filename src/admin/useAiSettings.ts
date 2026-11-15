import { useCallback, useEffect, useState } from 'react';
import type { AiBalance, AiSettingsView } from '../../shared/ai/index';
import { errorMessage, keyFailure, keySaved, type AiMessage } from './ai-settings-words';
import {
  readAiBalance,
  readAiSettings,
  removeAiKey,
  retestAiKey,
  saveAiKey,
  saveAiPreferences,
} from './settings-api';

/**
 * AI 设置页的数据：设置、余额、结果提示。busy 写明正在办哪件事（loading、balance、test、save、preferences、delete），
 * 空字符串是没在办。打开时读设置，有密钥就顺手查一次余额（免费）。
 */
export function useAiSettingsData() {
  const [view, setView] = useState<AiSettingsView | null>(null),
    [busy, setBusy] = useState('loading'),
    [balance, setBalance] = useState<AiBalance | null>(null),
    [balanceError, setBalanceError] = useState(''),
    [notice, setNotice] = useState<AiMessage | null>(null);
  /** 失败后服务端可能记下了新状态：重新读一次设置，读不到就留着眼前这份 */
  const reread = useCallback(async () => {
    try {
      setView(await readAiSettings());
    } catch {
      // 读不到就留着眼前这份设置：这次失败的原因调用方已经提示了，重读只是顺手刷新
    }
  }, []);
  /** 用这个页面凭证查余额（免费）。失败时状态由服务端记下，这里重新读一次设置。 */
  const checkBalance = useCallback(
    async (token: string) => {
      setBusy('balance');
      setBalanceError('');
      try {
        setBalance(await readAiBalance(token));
      } catch (e) {
        setBalance(null);
        setBalanceError(errorMessage(e).message);
      } finally {
        await reread();
        setBusy('');
      }
    },
    [reread],
  );
  // 打开页面时读一次设置，有密钥就顺手查一次余额（checkBalance 不随渲染变，只跑这一次）
  useEffect(() => {
    let alive = true;
    readAiSettings()
      .then((data) => {
        if (!alive) return;
        setView(data);
        setBusy('');
        if (data.hasKey && !data.storageError) void checkBalance(data.csrfToken);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setNotice(errorMessage(e));
        setBusy('');
      });
    return () => {
      alive = false;
    };
  }, [checkBalance]);
  /** 刷新余额：用眼前这份设置里的页面凭证 */
  const refreshBalance = () => checkBalance(view?.csrfToken || '');
  return { view, setView, busy, setBusy, balance, setBalance, balanceError, setBalanceError, notice, setNotice, reread, refreshBalance };
}
type AiSettingsData = ReturnType<typeof useAiSettingsData>;

/** AI 设置页改配置的几件事：保存密钥（先测再存，或只存）、重新测试、识别并发、删除密钥。 */
export function useAiKeyActions(data: AiSettingsData) {
  const { view, setView, setBusy, setBalance, setBalanceError, setNotice, reread } = data;
  const [apiKey, setApiKey] = useState(''),
    [showKey, setShowKey] = useState(false),
    [deleting, setDeleting] = useState(false);
  const token = view?.csrfToken || '';
  /** 改配置要带上看到时的版本号：设置还没读到时这几个按钮都锁着，走不到这里 */
  const revision = () => {
    if (!view) throw new Error('AI 设置还没读出来，请刷新后重试。');
    return view.revision;
  };
  /** 办一件事：busy 写明在办哪件；出错时默认提示原因，failed 给了就换成它 */
  async function work(kind: string, job: () => Promise<void>, failed: (e: unknown) => unknown = (e) => setNotice(errorMessage(e))) {
    setBusy(kind);
    try {
      await job();
    } catch (e) {
      await failed(e);
    } finally {
      setBusy('');
    }
  }
  const saveKey = (test: boolean) => {
    setNotice(null);
    const started = Date.now();
    return work(
      test ? 'test' : 'save',
      async () => {
        const { balance: next, ...rest } = await saveAiKey(token, test, { apiKey, expectedRevision: revision() });
        setView(rest);
        setApiKey('');
        setShowKey(false);
        setBalance(next || null);
        setBalanceError('');
        setNotice({ ok: true, message: keySaved(test, rest.check.state, (Date.now() - started) / 1000, next) });
      },
      async (e) => {
        setNotice(keyFailure(e));
        await reread();
      },
    );
  };
  const retest = () => {
    setNotice(null);
    return work(
      'test',
      async () => {
        const { balance: next, ...rest } = await retestAiKey(token, revision());
        setView(rest);
        setBalance(next);
        setBalanceError('');
        setNotice(
          rest.check.state === 'ok'
            ? { ok: true, message: '测试通过，可以使用。' }
            : { ok: false, code: rest.check.code, message: rest.check.message },
        );
      },
      async (e) => {
        setNotice(errorMessage(e));
        setBalance(null);
        await reread();
      },
    );
  };
  const setConcurrency = (value: number) =>
    work('preferences', async () => {
      setView(await saveAiPreferences(token, { expectedRevision: revision(), recognitionConcurrency: value }));
      setNotice({ ok: true, message: '已保存。服务繁忙时会自动改成逐个识别。' });
    });
  const removeKey = async () => {
    await work('delete', async () => {
      setView(await removeAiKey(token, revision()));
      setBalance(null);
      setBalanceError('');
      setNotice({ ok: true, message: '已删除密钥。' });
    });
    setDeleting(false);
  };
  return { apiKey, setApiKey, showKey, setShowKey, deleting, setDeleting, saveKey, retest, setConcurrency, removeKey };
}
export type AiKeyActions = ReturnType<typeof useAiKeyActions>;
