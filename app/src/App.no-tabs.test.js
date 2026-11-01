// The tab bar hides while a workout runs. It used to also hide under the Android app's
// first-launch card ("How do you want to use openGym?"), but that screen is gone from this
// build — its flag is only ever set by the native boot path — so the condition is the
// workout alone now. Shell is not rendered in a test, so this reads the condition from
// the source.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

describe('the tab bar', () => {
  it('stays away while a workout runs, and no onboarding branch remains', () => {
    const cond = app.match(/const noTabs = ([^\n]+)/)?.[1] || ''
    expect(cond).toContain('inWorkout')
    expect(cond).not.toContain('needsMobileOnboarding')
    expect(app).not.toContain('MobileOnboarding')
    expect(app).toMatch(/\{!noTabs && <TabBar /)
  })
})
