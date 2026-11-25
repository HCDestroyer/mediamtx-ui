import type { ReactNode } from "react";
import { Drawer, Modal, type UseOverlayStateReturn } from "@heroui/react";
import { DESKTOP_QUERY, useMediaQuery } from "../hooks/useMediaQuery";

interface ResponsiveOverlayProps {
  state: UseOverlayStateReturn;
  title: string;
  footer: ReactNode;
  children: ReactNode;
  size?: "md" | "lg";
}

/** Modal on desktop, bottom Drawer on mobile. */
export function ResponsiveOverlay({ state, title, footer, children, size = "md" }: ResponsiveOverlayProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (desktop) {
    return (
      <Modal state={state}>
        <Modal.Backdrop>
          <Modal.Container size={size} scroll="inside">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{title}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>{children}</Modal.Body>
              <Modal.Footer>{footer}</Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    );
  }
  return (
    <Drawer state={state}>
      <Drawer.Backdrop>
        <Drawer.Content placement="bottom">
          <Drawer.Dialog>
            <Drawer.Handle />
            <Drawer.Header>
              <Drawer.Heading>{title}</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>{children}</Drawer.Body>
            <Drawer.Footer>{footer}</Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
