/**
 * New API 登录页
 *
 * 支持账号密码和 API Key 两种方式。账号密码仅用于向 New API 创建专属令牌，
 * 后续模型请求统一使用 OpenAI 兼容 API Key。
 */

import * as React from 'react'
import { Eye, EyeOff, KeyRound, Loader2, LockKeyhole, Server, Sparkles, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { WindowControls } from '@/components/WindowControls'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'
import type { NewApiLoginMethod, NewApiLoginResult } from '@/types/new-api-auth'

interface NewApiLoginViewProps {
  onLoginSuccess: (result: NewApiLoginResult) => Promise<void>
  onCancel?: () => void
  initialMessage?: string
}

export function NewApiLoginView({
  onLoginSuccess,
  onCancel,
  initialMessage,
}: NewApiLoginViewProps): React.ReactElement {
  const { t } = useTranslation()
  const [method, setMethod] = React.useState<NewApiLoginMethod>('password')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState(initialMessage ?? '')
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  React.useEffect(() => {
    setError('')
  }, [method])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setError('')
    try {
      const result = method === 'password'
        ? await window.electronAPI.loginNewApiWithPassword({ username, password })
        : await window.electronAPI.loginNewApiWithApiKey({ apiKey })
      await onLoginSuccess(result)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : t('openSwitch.loginFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="relative flex h-screen w-screen overflow-hidden bg-background"
      role={onCancel ? 'dialog' : undefined}
      aria-modal={onCancel ? true : undefined}
      aria-label={onCancel ? t('openSwitch.loginTitle') : undefined}
    >
      <div
        className={cn(
          'titlebar-drag-region fixed left-0 top-0 z-50 h-[50px]',
          isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0',
        )}
      />
      <WindowControls />

      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-28 -top-36 size-[440px] rounded-full bg-primary/16 blur-3xl" />
        <div className="absolute -bottom-48 -right-24 size-[520px] rounded-full bg-violet-500/12 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,hsl(var(--background))_72%)]" />
      </div>

      <main className="relative z-10 m-auto grid w-full max-w-[980px] gap-10 px-8 py-16 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden flex-col justify-center lg:flex">
          <div className="mb-7 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Sparkles className="size-7" />
          </div>
          <h1 className="max-w-lg text-4xl font-semibold tracking-tight text-foreground">
            {t('openSwitch.optionalTitle')}
            <br />
            {t('openSwitch.optionalSubtitle')}
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">
            {t('openSwitch.optionalDescription')}
          </p>

          <div className="mt-10 space-y-4">
            <Feature icon={LockKeyhole} title={t('openSwitch.securityTitle')} description={t('openSwitch.securityDescription')} />
            <Feature icon={Server} title={t('openSwitch.channelTitle')} description={t('openSwitch.channelDescription')} />
          </div>
        </section>

        <section className="rounded-3xl bg-card/90 p-7 shadow-2xl shadow-black/10 ring-1 ring-foreground/5 backdrop-blur-xl sm:p-9">
          <div className="mb-7 lg:hidden">
            <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Sparkles className="size-5" />
            </div>
            <h1 className="text-2xl font-semibold">{t('openSwitch.loginTitle')}</h1>
          </div>

          <div className="mb-6 rounded-xl bg-muted/55 p-1">
            <div className="grid grid-cols-2 gap-1">
              <MethodButton
                active={method === 'password'}
                icon={UserRound}
                label={t('openSwitch.passwordMethod')}
                onClick={() => setMethod('password')}
              />
              <MethodButton
                active={method === 'api-key'}
                icon={KeyRound}
                label={t('openSwitch.apiKeyMethod')}
                onClick={() => setMethod('api-key')}
              />
            </div>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            {method === 'password' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="new-api-username">{t('openSwitch.username')}</Label>
                  <Input
                    id="new-api-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={t('openSwitch.usernamePlaceholder')}
                    autoComplete="username"
                    autoFocus
                    disabled={submitting}
                    className="h-11 bg-background/70"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-api-password">{t('openSwitch.password')}</Label>
                  <div className="relative">
                    <Input
                      id="new-api-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={t('openSwitch.passwordPlaceholder')}
                      autoComplete="current-password"
                      disabled={submitting}
                      className="h-11 bg-background/70 pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="absolute right-0 top-0 flex size-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={showPassword ? t('openSwitch.hidePassword') : t('openSwitch.showPassword')}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('openSwitch.passwordHint')}
                </p>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="new-api-key">API Key</Label>
                  <Input
                    id="new-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                    autoFocus
                    disabled={submitting}
                    className="h-11 bg-background/70 font-mono"
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('openSwitch.apiKeyHint')}
                </p>
              </>
            )}

            {error && (
              <div role="alert" className="rounded-xl bg-destructive/10 px-3.5 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="h-11 w-full text-sm font-medium shadow-lg shadow-primary/15"
              disabled={
                submitting
                || (method === 'password' ? !username.trim() || !password : !apiKey.trim())
              }
            >
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {submitting ? t('openSwitch.loggingIn') : t('openSwitch.loginSubmit')}
            </Button>
            {onCancel && (
              <Button
                type="button"
                variant="ghost"
                className="h-10 w-full"
                disabled={submitting}
                onClick={onCancel}
              >
                {t('openSwitch.skip')}
              </Button>
            )}
          </form>

        </section>
      </main>
    </div>
  )
}

interface MethodButtonProps {
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
}

function MethodButton({
  active,
  icon: Icon,
  label,
  onClick,
}: MethodButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-9 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}

interface FeatureProps {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}

function Feature({
  icon: Icon,
  title,
  description,
}: FeatureProps): React.ReactElement {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="size-4" />
      </div>
      <div>
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
