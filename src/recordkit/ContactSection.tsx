import { Facts, Section } from '../ui/index';
import { fieldLabel } from '../../shared/core/index';

/** 客户、供应商档案里的联系方式几项 */
type Contact = { contact: string; phone: string; address: string; notes: string };

/** 客户、供应商详情的“联系方式”：联系人、联系方式、地址、备注，两边同一份。 */
export default function ContactSection({ row }: { row: Contact }) {
  return (
    <Section title="联系方式">
      <Facts
        items={[
          { label: fieldLabel('contact'), value: row.contact },
          { label: fieldLabel('phone'), value: row.phone },
          { label: fieldLabel('address'), value: row.address, wide: true },
          { label: fieldLabel('notes'), value: row.notes, wide: true },
        ]}
      />
    </Section>
  );
}
