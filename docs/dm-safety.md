# DM safety review

Direct messages and private groups are no longer fully private. The owner can
review them to deal with sexual content and other abuse. Members can report
messages they receive. Mods, managers, admins and co-owners still cannot read
DMs.

## What is built

| Part | Status |
| --- | --- |
| Backend: `Backend/migrations/20261103180000_dm_reports.sql` | Written and tested locally. **Not applied to production.** |
| Control: owner-only **DM safety** page | Written and tested locally. Publishes when merged to `main`. |
| Chat: Report button and privacy wording | **Planned only** (see below). `Chat/` is unchanged. |

### Access model

| Who | Access |
| --- | --- |
| Owner / PRESTON through a Control session | Lists conversations, reads any DM or private group (paged), searches all DM text, opens private-group attachments, reviews and resolves reports, removes messages. Timeout/ban use the existing Control actions. |
| Owner / PRESTON in Chat | Same as any member. Chat queries stay participant-only. The one change is that an owner session can now sign private-group attachment URLs. Control uses this to show group images. |
| Co-owner, admin, manager, mod | No new access. Control hides the page, and every RPC refuses a non-owner session (`require_chat_admin(token, true)`). |
| Conversation members | Can report messages other people sent in conversations they belong to (`chat_report_dm_message`). Limit: 20 new reports per hour. |
| Browsers | Cannot read or write `private.chat_dm_reports` directly. RLS is on with no policies, and all grants are revoked. |

Removing a message soft-deletes it, the same way staff deletes already work.
The original stays in the moderation archive, and any reports keep their own
snapshot. Removing a message also settles that message's open reports.

### Audit

The owner's DM actions are written to `private.chat_admin_audit`:
`dm_conversation_viewed`, `dm_search`, `dm_report_context_viewed`,
`dm_report_resolved` and `dm_message_removed`. Entries record the participants
or reported user, and search terms. They never contain message text.

Control's audit log is visible to every administrator. Admins can therefore
see *that* the owner opened a conversation and between whom, but not what it
said. That transparency is intentional.

## Deploying

1. Apply `20261103180000_dm_reports.sql` to the production database (Supabase
   SQL editor or `supabase db push`). HTML publication does not run it. It
   adds a table, functions and storage policies. It replaces the
   `group_media_members_only` storage policy with per-command equivalents and
   adds an owner read exception.
2. Merge to `main`. The Admin workflow publishes Control. Before the SQL is
   applied, the DM safety page shows "DM safety needs the
   20261103180000_dm_reports SQL migration."
3. Update the privacy text and add reporting in Chat (plan below) before or
   alongside telling members.

Rollback: drop the new `admin_dashboard_*dm*` and `chat_report_dm_message`
functions. Restore the original `group_media_members_only` policy and the
earlier `private.chat_guard_group_message` from
`20261013234532_private_group_chats.sql`. The report table can be kept as
evidence.

## Chat plan (not implemented)

### 1. Privacy wording

Replace the paragraphs in Settings → Account → *How your data works*
(`Chat/chat.html`, the `.privacy-copy` block) with:

> Your account and messages are stored on the server. Your password is stored
> as a hash. Themes, drafts, and local settings stay in this browser unless you
> export or clear them.
>
> **Direct messages and private groups are not end-to-end encrypted.** To keep
> people safe, the owner can review direct messages and private groups,
> including attachments, and can remove messages or restrict accounts that
> break the rules. Moderators and admins cannot read them. Every review is
> recorded in an audit log.
>
> You can report a message someone sends you. Reports go only to the owner and
> include a copy of the message, even if it is later deleted.
>
> Deleted channel and direct messages remain in the moderation archive.
> Private-group members can see the group's earlier messages after accepting
> an invite.
>
> Deleting your account removes your login and profile. Your messages remain
> in channels and DMs under your username. Signing out ends only this session.

Update the delete-message confirmation copy in `deleteMessage` to match. Its
private-group line, "Staff outside this group cannot read its archived
content", is no longer true for the owner.

Announce the change once, for example with Control's What's New, so existing
members see it without opening Settings.

### 2. Report button

- In `renderMsgActions`, add a flag button when `currentView.type === 'dm'`,
  the message isn't the viewer's own, and it isn't a private-call invite.
  This covers both DMs and private groups.
- Add a small `report-dialog` with reason radios (Sexual content, Harassment,
  Spam, Self-harm, Other), an optional 500-character note, and the line
  "The owner will see this message and the conversation around it."
  `confirmAction` only supports one text field, so it can't be reused here.
- On submit, call
  `sb.rpc('chat_report_dm_message', { p_message_id, p_reason, p_details })`.
  Show "Reported. Thanks for letting us know." On `duplicate: true`, show
  "You already reported this message. We updated your reason." If the function
  is missing, show "Reporting needs the dm_reports SQL update."
- Optionally offer "Also block @user" after a report on a 1:1 DM. It would
  reuse the existing block flow.
- Bump `APP_VERSION` (2.28) and add a README entry. Add a static test that the
  button only renders for other people's DM messages.

### 3. Self-harm reports

`self_harm` is a report reason so those reports can be found quickly. Nothing
happens automatically. The owner decides what to do.

## Legal note

If a report involves sexual content with a minor, deleting the message is not
enough. Platforms in the US must report apparent child sexual abuse material
to NCMEC (CyberTipline), and other countries have similar duties. Keep the
evidence (reports keep their snapshot; soft deletes keep the original), and
check what applies to you.
