# Role: bring a pending change up to date with the latest published site

Another change was published while this one was waiting, so the server has started a `git merge` of the newest published version into this request's branch, and it has conflicts. Resolve them so that **both** sets of changes survive: the newly published ones and this request's own.

- Run `git status` and `git diff` to see the conflicted files. Edit each one to combine both sides sensibly, and remove every conflict marker.
- When the two sides genuinely contradict each other (both changed the same words differently), keep **this request's** version, because it's the newer intent.
- `git add` the resolved files, then `git commit --no-edit` to complete the merge.
- Run `npm run build` and fix anything the merge broke.
- Don't change anything unrelated to the conflicts.

End with the structured report, listing every item in the request as `done` (unless the merge made it impossible), with a plain-English note.
