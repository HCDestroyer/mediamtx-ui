import { useState } from "react";
import { Alert, Button, Card } from "@heroui/react";
import { Lock } from "lucide-react";
import { t } from "../../i18n/es";
import { useAuth } from "../../store/auth";
import { AccountForm } from "./AccountForm";

/** First-run screen: create the panel account, or skip it. */
export default function SetupScreen() {
  const [pending, setPending] = useState(false);
  const createAccount = useAuth((s) => s.createAccount);
  const skipSetup = useAuth((s) => s.skipSetup);

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] px-4 py-8 pt-safe pb-safe">
      <Card className="w-full max-w-md">
        <Card.Content className="flex flex-col gap-5 p-1 sm:p-3">
          <div className="flex flex-col gap-2">
            <span className="grid size-11 place-items-center rounded-2xl bg-[var(--accent)] text-[var(--accent-foreground)]">
              <Lock size={20} aria-hidden />
            </span>
            <h1 className="text-2xl font-bold tracking-tight">{t.auth.setupTitle}</h1>
            <p className="text-sm text-[var(--muted)]">{t.auth.setupBody}</p>
          </div>
          <AccountForm
            id="setup-form"
            mode="create"
            onPendingChange={setPending}
            onSubmit={async ({ username, password }) => {
              await createAccount(username, password);
              return null;
            }}
          />
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t.auth.setupWarning}</Alert.Description>
            </Alert.Content>
          </Alert>
          <div className="flex flex-col gap-2">
            <Button variant="primary" type="submit" form="setup-form" isPending={pending} fullWidth>
              {t.auth.setupCreate}
            </Button>
            <Button variant="ghost" onPress={skipSetup} isDisabled={pending} fullWidth>
              {t.auth.setupSkip}
            </Button>
          </div>
        </Card.Content>
      </Card>
    </main>
  );
}
