import { Button } from "@heroui/react";
import { t } from "../i18n/es";

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h1 className="text-xl font-bold">{t.notFound.title}</h1>
      <Button variant="primary" onPress={() => (window.location.hash = "#/")}>
        {t.notFound.back}
      </Button>
    </div>
  );
}
