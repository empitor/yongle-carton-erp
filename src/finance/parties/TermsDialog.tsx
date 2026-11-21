import { useEffect, useState } from 'react';
import { FormMessage, FormSection, FormField, useLoad, Loading } from '../../ui/index';
import { EditorShell } from '../editor';
import { FinCheck, PartyField } from '../fields';
import { emptyTerms, isBlankTerms, termsBody, termsFormOf, type TermsForm } from './terms-form';
import { InterestTerms, TaxCreditSection, TermSection } from './TermsSections';
import { DiscountsSection, InstallmentsSection } from './TermsLines';
import { readPartyTerms, savePartyTerms } from './parties-api';

/**
 * 账期窗口：账期、默认税率、现结优惠、分期、保证金、压款利息都在这里调。比例全部由人填。
 * “没有约定”单独存成 none，到期日留空；“压 0 天”是当天到期，两者不能混。
 */
export default function TermsDialog({
  kind,
  partyId: fixedParty,
  partyName,
  close,
}: {
  kind: 'customer' | 'supplier';
  partyId?: string;
  /** 从列表打开时的单位名称，写在标题下面 */
  partyName?: string;
  close: () => void;
}) {
  const [partyId, setPartyId] = useState(fixedParty || '');
  /** 新建时选的单位名称，保存后的提示里用 */
  const [pickedName, setPickedName] = useState('');
  const [form, setForm] = useState<TermsForm>(emptyTerms);
  const { discounts, installments, deposits } = form;
  const set = (patch: Partial<TermsForm>) => setForm((f) => ({ ...f, ...patch }));
  const setList = <K extends 'discounts' | 'installments'>(
    key: K,
    fn: (all: TermsForm[K]) => TermsForm[K],
  ) => setForm((f) => ({ ...f, [key]: fn(f[key]) }));
  // 选了单位就读它现在的账期，读到后填进表单；读完才能改
  const terms = useLoad(partyId ? kind + '/' + partyId : null, () => readPartyTerms(kind, partyId));
  const ready = !!partyId && !terms.loading && !terms.error;
  const loaded = ready ? terms.data : undefined;
  useEffect(() => {
    if (ready) setForm(termsFormOf(terms.data));
  }, [ready, terms.data]);
  const who = kind === 'customer' ? '客户' : '供应商';
  const whose = kind === 'customer' ? '客户多久付给我们' : '我们多久付给供应商';
  const save = async () => {
    if (!partyId) throw new Error('请选择往来单位。');
    // 已有设置时允许改回“没有约定”并清空其他规则；新建时至少要填一项
    if (!loaded && isBlankTerms(form)) throw new Error('还没填写任何规则。');
    await savePartyTerms(kind, partyId, {
      ...termsBody(form),
      ...(loaded ? { version: loaded.version } : {}),
    });
    return (partyName || pickedName || who) + ' 的账期已保存，之后的新单据按新规则算。';
  };
  return (
    <EditorShell
      title={fixedParty ? '编辑账期' : '新建' + who + '账期'}
      subtitle={fixedParty ? partyName || undefined : undefined}
      size="lg"
      note="只影响之后的新单据；已有单据要改到期日，到欠款明细用“按新账期重算到期日”。"
      submitLabel="保存账期"
      close={close}
      submit={save}
    >
      <FormMessage>{terms.error}</FormMessage>
      {!fixedParty && (
        <FormSection title={'给哪个' + who} columns={2}>
          <FormField label={who} required>
            <PartyField
              kind={kind}
              label="往来单位"
              required
              value={partyId}
              onChange={(v, name) => {
                setPartyId(v);
                setPickedName(name);
              }}
            />
          </FormField>
        </FormSection>
      )}
      {fixedParty && !ready && !terms.error && (
        <Loading what="现有设置" />
      )}
      {/* 读到这个单位的现有规则之前不让填，免得读回来盖掉刚填的内容 */}
      <fieldset className="fin-term-body" disabled={!ready}>
        <TermSection form={form} set={set} whose={whose} />

        <TaxCreditSection form={form} set={set} />

        <DiscountsSection discounts={discounts} onChange={(fn) => setList('discounts', fn)} />

        <InstallmentsSection
          installments={installments}
          onChange={(fn) => setList('installments', fn)}
        />

        <InterestTerms form={form} set={set} />

        <FormSection title="保证金" columns={1}>
          <FinCheck
            label="这个单位有保证金往来"
            hint="只作标记，金额在账期页的“保证金”一节新建。"
            checked={deposits}
            onChange={(v) => set({ deposits: v })}
          />
        </FormSection>
      </fieldset>
    </EditorShell>
  );
}
