import { Facts, Section } from '../ui/index';
import { fieldNames } from '../../shared/business/index';

/** 客户、供应商档案里的联系方式几项 */
type Contact = { contact: string; phone: string; address: string; notes: string };

/** 客户、供应商详情的“联系方式”：联系人、联系方式、地址、备注，两边同一份。 */
export default function ContactSection({ row }: { row: Contact }) {
  return (
    <Section title="联系方式">
      <Facts
        items={[
          { label: fieldNames.contact, value: row.contact },
          { label: fieldNames.phone, value: row.phone },
          { label: fieldNames.address, value: row.address, wide: true },
          { label: '备注', value: row.notes, wide: true },
        ]}
      />
    </Section>
  );
}
