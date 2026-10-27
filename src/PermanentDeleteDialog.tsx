import DatabaseDeleteDialog from './DatabaseDeleteDialog';
import type { RecordEntity } from '../shared/operations';
export default function PermanentDeleteDialog({
  entity,
  rows,
  close,
  done,
}: {
  entity: RecordEntity;
  rows: any[];
  close: () => void;
  done: (message: string) => void;
}) {
  return <DatabaseDeleteDialog module={entity} rows={rows} close={close} done={done} />;
}
