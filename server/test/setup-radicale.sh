#!/usr/bin/env bash
# Starts a throwaway Radicale CalDAV/CardDAV server on 127.0.0.1:5232 with user alice/secret123,
# a calendar "Work" (cal1), an address book "People" (book1), one event and one contact.
# Then run: TEST_DAV_URL=http://127.0.0.1:5232/alice/ npm test
set -euo pipefail
DIR=${RADICALE_TEST_DIR:-/var/tmp/halcyon-radicale}
rm -rf "$DIR" && mkdir -p "$DIR"
python3 -m venv "$DIR/venv" && "$DIR/venv/bin/pip" install -q radicale
printf 'alice:secret123\n' > "$DIR/users"
cat > "$DIR/config" <<CONF
[server]
hosts = 127.0.0.1:5232
[auth]
type = htpasswd
htpasswd_filename = $DIR/users
htpasswd_encryption = plain
[storage]
filesystem_folder = $DIR/collections
CONF
nohup "$DIR/venv/bin/radicale" --config "$DIR/config" > "$DIR/log" 2>&1 &
sleep 2
U=alice:secret123; B=http://127.0.0.1:5232/alice
curl -sf -u $U -X MKCOL $B/cal1/ -H 'Content-Type: application/xml' --data '<?xml version="1.0"?><mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Work</displayname></prop></set></mkcol>'
curl -sf -u $U -X MKCOL $B/book1/ -H 'Content-Type: application/xml' --data '<?xml version="1.0"?><mkcol xmlns="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><set><prop><resourcetype><collection/><CR:addressbook/></resourcetype><displayname>People</displayname></prop></set></mkcol>'
curl -sf -u $U -X PUT $B/cal1/ev1.ics -H 'Content-Type: text/calendar' --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\nBEGIN:VEVENT\r\nUID:remote-ev-1\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261021T080000Z\r\nDTEND:20261021T090000Z\r\nSUMMARY:Remote planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
curl -sf -u $U -X PUT $B/book1/c1.vcf -H 'Content-Type: text/vcard' --data-binary $'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-c-1\r\nFN:Remote Person\r\nN:Person;Remote;;;\r\nEMAIL:remote@example.com\r\nEND:VCARD\r\n'
echo "Radicale test server running on http://127.0.0.1:5232/alice/"
