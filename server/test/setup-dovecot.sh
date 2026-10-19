#!/usr/bin/env bash
# Starts a throwaway Dovecot IMAP server on 127.0.0.1:1143 for the end-to-end tests.
# Users: alice@test.local, bob@test.local (password: secret123). Requires root (Ubuntu/Debian).
set -euo pipefail
command -v dovecot >/dev/null || { apt-get update -q && apt-get install -y -q dovecot-imapd; }
id vmail >/dev/null 2>&1 || useradd -r -M vmail
DIR=${DOVECOT_TEST_DIR:-/var/tmp/halcyon-dovecot}
mkdir -p "$DIR/run" /var/tmp/halcyon-mail && chown vmail:vmail /var/tmp/halcyon-mail
printf 'alice@test.local:{PLAIN}secret123\nbob@test.local:{PLAIN}secret123\n' > /etc/dovecot/test-users && chmod 644 /etc/dovecot/test-users
cat > "$DIR/dovecot.conf" <<CONF
protocols = imap
listen = 127.0.0.1
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
base_dir = $DIR/run
log_path = $DIR/dovecot.log
first_valid_uid = 1
mail_location = maildir:/var/tmp/halcyon-mail/%u
passdb {
  driver = passwd-file
  args = scheme=PLAIN username_format=%u /etc/dovecot/test-users
}
userdb {
  driver = static
  args = uid=vmail gid=vmail home=/var/tmp/halcyon-mail/%u
}
service imap-login {
  inet_listener imap {
    port = 1143
  }
}
namespace inbox {
  inbox = yes
  separator = /
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
  mailbox Archive {
    special_use = \Archive
    auto = subscribe
  }
}
CONF
dovecot -c "$DIR/dovecot.conf" stop 2>/dev/null || true
sleep 1
dovecot -c "$DIR/dovecot.conf"
echo "Dovecot test server running on 127.0.0.1:1143"
