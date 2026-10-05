# herd

## Agent environment rules (auto)
- Ports: this env owns 4700-4799. Main checkout dev server = 4700; a worktree uses
  the PORT in its .env.agents. Never bind another env's ports. One dev server; stop it when done.
- GitHub home: neegy-corp. Never push unless the operator asks (pushes are secret-scanned and blocked if dirty).
- Keys: only Claude sessions may handle them (rules in ~/project-workspace/CLAUDE.md). Free workers never.
- In a worktree (.worktrees/ in the path): stay on your branch; before finishing run: git rebase main
- Finish with 3 lines in NOTES.md: what changed, what's left, anything risky.
