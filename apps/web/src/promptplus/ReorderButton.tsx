/** CLOUD ONLY. "สั่งซื้อใน Prompt Plus" (phase 2 placeholder; POST /api/promptplus/orders is a stub on the server). */
import { useMeta } from '../data';
import { useToast } from '../ui';

export default function ReorderButton() {
  const meta = useMeta();
  const toast = useToast();
  if (!meta.data?.capabilities.promptPlusOrders) return null;
  return (
    <button className="btn sm" data-testid="pp-order" onClick={() => toast('สั่งซื้อใน Prompt Plus จากหน้านี้เป็นฟีเจอร์เฟส 2')}>
      สั่ง Prompt Plus
    </button>
  );
}
