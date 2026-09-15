import { useEffect, useState, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { webAuthService, type WebAuthStatus } from "@/services/webAuthService";
import { isTauriRuntime } from "@/services/runtime";

interface WebAuthGateProps {
  children: ReactNode;
}

export default function WebAuthGate({ children }: WebAuthGateProps) {
  const { t } = useTranslation("common");
  const [status, setStatus] = useState<WebAuthStatus | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isTauriRuntime()) return;
    let cancelled = false;
    webAuthService.status()
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setUsername(nextStatus.username || "admin");
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isTauriRuntime()) return;
    const handleManualLock = () => {
      setStatus((current) => current?.authRequired ? { ...current, authenticated: false } : current);
    };
    window.addEventListener("cc-panes:web-locked", handleManualLock);
    return () => window.removeEventListener("cc-panes:web-locked", handleManualLock);
  }, []);

  useEffect(() => {
    if (isTauriRuntime() || !status?.authRequired || !status.authenticated || status.lockOnIdleMinutes <= 0) {
      return;
    }
    let lastActivity = Date.now();
    const markActivity = () => {
      lastActivity = Date.now();
    };
    const lockIfIdle = async () => {
      if (Date.now() - lastActivity < status.lockOnIdleMinutes * 60_000) {
        return;
      }
      await webAuthService.lock().catch(() => undefined);
      setStatus({ ...status, authenticated: false });
    };

    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((eventName) => window.addEventListener(eventName, markActivity, { passive: true }));
    const timer = window.setInterval(() => {
      void lockIfIdle();
    }, 30_000);

    return () => {
      window.clearInterval(timer);
      events.forEach((eventName) => window.removeEventListener(eventName, markActivity));
    };
  }, [status]);

  if (isTauriRuntime()) {
    return <>{children}</>;
  }

  if (!status) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: "var(--app-bg-deep)", color: "var(--app-text-secondary)" }}>
        {error ?? "Loading CC-Panes..."}
      </div>
    );
  }

  if (!status.authRequired || status.authenticated) {
    return <>{children}</>;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await webAuthService.login({ username, password });
      const nextStatus = await webAuthService.status();
      setStatus(nextStatus);
      setPassword("");
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="h-screen flex items-center justify-center px-4"
      style={{ background: "var(--app-bg-deep)", color: "var(--app-text-primary)" }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[360px] flex flex-col gap-4 rounded-lg p-5"
        style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
      >
        <div className="flex items-center gap-2">
          <LockKeyhole className="w-5 h-5" style={{ color: "var(--app-accent)" }} />
          <h1 className="text-base font-semibold">{t("webAuth.lockedTitle")}</h1>
        </div>
        <div className="flex flex-col gap-2">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("webAuth.usernamePlaceholder")} />
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("webAuth.passwordPlaceholder")}
            autoFocus
          />
        </div>
        {error && (
          <p className="text-xs m-0" style={{ color: "var(--app-accent)" }}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting || !username.trim()}>
          {submitting ? t("webAuth.submitting") : t("webAuth.unlock")}
        </Button>
      </form>
    </div>
  );
}
