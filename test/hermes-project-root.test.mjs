/**
 * Card worktree paths collapse back to their parent repo: a worker thread
 * running in <repo>/.worktrees/<card-id> belongs to <repo>'s plot.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectRoot } from '../server/harnesses/hermes.mjs'

test('a card worktree collapses to its parent repo', () => {
  assert.equal(projectRoot('/home/hermes/bot-crossing/.worktrees/t_abc'), '/home/hermes/bot-crossing')
})

test('deeper paths under a worktree collapse too', () => {
  assert.equal(projectRoot('/home/hermes/bot-crossing/.worktrees/t_abc/src/x'), '/home/hermes/bot-crossing')
})

test('a plain repo path passes through unchanged', () => {
  assert.equal(projectRoot('/plain/repo'), '/plain/repo')
})

test('an empty root stays empty', () => {
  assert.equal(projectRoot(''), '')
})

test('windows-style separators collapse as well', () => {
  assert.equal(projectRoot('C:\\repo\\.worktrees\\t_x'), 'C:\\repo')
})

test('a `.worktrees`-prefixed sibling directory is not a worktree', () => {
  assert.equal(projectRoot('/plain/.worktrees-x/t_abc'), '/plain/.worktrees-x/t_abc')
})

test('a scratch workspace collapses to the agent home bucket', () => {
  assert.equal(
    projectRoot('/home/hermes/.hermes/kanban/workspaces/t_18210d94'),
    '/home/hermes/.hermes'
  )
})

test('deeper paths under a scratch workspace collapse too', () => {
  assert.equal(
    projectRoot('/home/hermes/.hermes/kanban/workspaces/t_x/deeper'),
    '/home/hermes/.hermes'
  )
})

test('a `workspaces`-prefixed sibling directory is not a scratch workspace', () => {
  assert.equal(
    projectRoot('/plain/kanban/workspaces-x/t_abc'),
    '/plain/kanban/workspaces-x/t_abc'
  )
})
