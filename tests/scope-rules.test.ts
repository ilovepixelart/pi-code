import { describe, expect, it } from 'vitest'

import { matchesAgentRules, matchesDomainRules, matchesSkillRules } from '../extensions/internal/scope-rules.js'

/**
 * Oracles are the permissions reference's own worked examples, quoted per case, not
 * the implementation: "WebFetch rules use a `domain:` prefix and match against the
 * hostname of the requested URL. Matching is case-insensitive, supports `*` wildcards,
 * and strips a trailing `.` from both the rule and the hostname".
 */
describe('matchesDomainRules', () => {
  it('matches the exact host, per `WebFetch(domain:example.com)` matches requests to example.com', () => {
    expect(matchesDomainRules('https://example.com/a/b?q=1', ['domain:example.com'])).toBe(true)
    expect(matchesDomainRules('https://evil.com/', ['domain:example.com'])).toBe(false)
  })

  it('a leading `*.` matches any subdomain at any depth but not the apex', () => {
    // Doc: "matches any subdomain at any depth, such as `api.example.com` or
    // `a.b.example.com`, but not `example.com` itself".
    expect(matchesDomainRules('https://api.example.com/', ['domain:*.example.com'])).toBe(true)
    expect(matchesDomainRules('https://a.b.example.com/', ['domain:*.example.com'])).toBe(true)
    expect(matchesDomainRules('https://example.com/', ['domain:*.example.com'])).toBe(false)
  })

  it('a bare `*` matches every domain', () => {
    expect(matchesDomainRules('https://anything.test/', ['domain:*'])).toBe(true)
  })

  it('a wildcard elsewhere matches only text between two dots', () => {
    // Doc: "`WebFetch(domain:example.*)` matches `example.org`, where `*` becomes `org`,
    // but not `example.evil.com`, where `*` would have to become `evil.com` and cross a
    // dot. This keeps a trailing wildcard from matching domains an attacker could register."
    expect(matchesDomainRules('https://example.org/', ['domain:example.*'])).toBe(true)
    expect(matchesDomainRules('https://example.evil.com/', ['domain:example.*'])).toBe(false)
  })

  it('matches case-insensitively and strips a trailing dot from rule and hostname', () => {
    expect(matchesDomainRules('https://EXAMPLE.com/', ['domain:example.com'])).toBe(true)
    expect(matchesDomainRules('https://example.com./', ['domain:example.com'])).toBe(true)
    expect(matchesDomainRules('https://example.com/', ['domain:example.com.'])).toBe(true)
  })

  it('matches when any one rule matches', () => {
    expect(matchesDomainRules('https://b.test/', ['domain:a.test', 'domain:b.test'])).toBe(true)
  })

  it('fails closed on a scope that is not the documented `domain:` form', () => {
    // The reference gives WebFetch exactly one specifier syntax. An allow scope we
    // cannot interpret must not read as "allow everything".
    expect(matchesDomainRules('https://example.com/', ['example.com'])).toBe(false)
    expect(matchesDomainRules('https://example.com/', [''])).toBe(false)
    expect(matchesDomainRules('https://example.com/', ['domain:'])).toBe(false)
  })

  it('fails closed on a url it cannot parse', () => {
    expect(matchesDomainRules('not a url', ['domain:*'])).toBe(false)
    expect(matchesDomainRules('', ['domain:*'])).toBe(false)
  })
})

/**
 * Doc: "Use `Agent(AgentName)` rules to control which subagents Claude can use:
 * `Agent(Explore)` matches the Explore subagent ... `Agent(my-custom-agent)` matches a
 * custom subagent named `my-custom-agent`."
 */
describe('matchesAgentRules', () => {
  it('matches the named agent and refuses another', () => {
    expect(matchesAgentRules(['Explore'], ['Explore'])).toBe(true)
    expect(matchesAgentRules(['Plan'], ['Explore'])).toBe(false)
  })

  it('requires every agent in the call to match, so a second one cannot ride along', () => {
    // A subagent call carries agent names in `agent`, `tasks[].agent` and `chain[].agent`.
    // Gating only the first would let parallel mode route around the rule.
    expect(matchesAgentRules(['Explore', 'Explore'], ['Explore'])).toBe(true)
    expect(matchesAgentRules(['Explore', 'Plan'], ['Explore'])).toBe(false)
  })

  it('accepts a call matching any one of several rules', () => {
    expect(matchesAgentRules(['Plan'], ['Explore', 'Plan'])).toBe(true)
  })

  it('fails closed on a call that names no agent at all', () => {
    // A scoped grant must never be satisfied by a call the rule cannot be checked against.
    expect(matchesAgentRules([], ['Explore'])).toBe(false)
  })

  it('fails closed on an empty scope, as Bash() and Read() do', () => {
    expect(matchesAgentRules(['Explore'], [''])).toBe(false)
  })
})

/**
 * Doc: "Permission syntax: `Skill(name)` for exact match, `Skill(name *)` for prefix
 * match with any arguments", shown under "Allow only specific skills".
 */
describe('matchesSkillRules', () => {
  it('matches an exact name and refuses another', () => {
    expect(matchesSkillRules('commit', ['commit'])).toBe(true)
    expect(matchesSkillRules('deploy', ['commit'])).toBe(false)
  })

  it('an exact rule does not match the same skill invoked with arguments', () => {
    // `Skill(commit)` is the exact form; the arguments form is `Skill(commit *)`.
    expect(matchesSkillRules('commit --amend', ['commit'])).toBe(false)
  })

  it('a trailing ` *` matches the skill with any arguments', () => {
    expect(matchesSkillRules('review-pr 123', ['review-pr *'])).toBe(true)
    expect(matchesSkillRules('review-pr a b c', ['review-pr *'])).toBe(true)
  })

  it('a trailing ` *` also matches the bare skill, as the same wildcard does for Bash', () => {
    // Permissions reference, on the shared wildcard engine: "A `*` at the end, with a
    // space before it, also matches the bare command." A rule allowing a skill has to
    // cover its commonest invocation, which is the skill with no arguments.
    expect(matchesSkillRules('review-pr', ['review-pr *'])).toBe(true)
  })

  it('a prefix rule does not match a longer skill name', () => {
    // `review-pr *` must not reach `review-pretend`: the space is part of the rule.
    expect(matchesSkillRules('review-pretend', ['review-pr *'])).toBe(false)
    expect(matchesSkillRules('review-pretend 1', ['review-pr *'])).toBe(false)
  })

  it('ignores a leading slash on the invocation, which the tool accepts either way', () => {
    expect(matchesSkillRules('/commit', ['commit'])).toBe(true)
    expect(matchesSkillRules('/review-pr 123', ['review-pr *'])).toBe(true)
  })

  it('matches when any one rule matches', () => {
    expect(matchesSkillRules('commit', ['deploy *', 'commit'])).toBe(true)
  })

  it('fails closed on an empty scope and on an empty invocation', () => {
    expect(matchesSkillRules('commit', [''])).toBe(false)
    expect(matchesSkillRules('', ['commit'])).toBe(false)
    expect(matchesSkillRules('   ', ['commit'])).toBe(false)
  })

  it('fails closed on a wildcard form the reference does not give Skill', () => {
    // Only `name` and `name *` are documented. An uninterpretable scope is a rule that
    // matches nothing, never the unscoped grant the author did not write.
    expect(matchesSkillRules('commit', ['commit:*'])).toBe(false)
    expect(matchesSkillRules('commit', ['*'])).toBe(false)
  })
})
