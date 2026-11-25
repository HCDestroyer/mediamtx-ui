import { useState } from "react";
import { AlertDialog, Button, toast, type UseOverlayStateReturn } from "@heroui/react";
import { deletePathConf } from "../core/mediamtx/api";
import { apiErrorMessage, usePathApi } from "../hooks/usePathApi";
import { fmt, t } from "../i18n/es";

interface DeleteChannelDialogProps {
  state: UseOverlayStateReturn;
  name: string;
  /** Dynamic channels have no configuration to delete. */
  dynamic: boolean;
  onDeleted: () => void;
}

/** Confirmation before removing a path configuration; destructive actions always ask. */
export function DeleteChannelDialog({ state, name, dynamic, onDeleted }: DeleteChannelDialogProps) {
  const api = usePathApi();
  const [pending, setPending] = useState(false);

  const remove = async () => {
    if (!api.client) return;
    setPending(true);
    try {
      await deletePathConf(api.client, name);
      api.wrote();
      toast.success(t.del.deleted);
      state.close();
      onDeleted();
    } catch (error) {
      toast.danger(t.del.failed, { description: apiErrorMessage(error, "") || undefined });
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog isOpen={state.isOpen} onOpenChange={state.setOpen}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t.del.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{dynamic ? t.del.dynamicBody : fmt(t.del.body, { name })}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={state.close}>{t.edit.cancel}</Button>
              {dynamic ? null : (
                <Button variant="danger" onPress={remove} isPending={pending}>{t.del.confirm}</Button>
              )}
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
