// Real output from the live workspace-mcp (workspace, Google Workspace MCP
// v2.6.0), captured 2026-11-27 for rick@theashfords.org. The parser tests in
// mailcensus.test.ts must stay in step with this file: when the server's
// output changes, these fixtures change with it.
//
// SEARCH_PAGE is a real search_gmail_messages result (15 of a larger set, so
// the pagination line is present). LAST_PAGE and EMPTY_PAGE are the same
// format with the pagination line absent / zero results: the server prints
// the "PAGINATION" line only when a next page exists.
// METADATA is a real get_gmail_messages_content_batch result, format=metadata.
// READ_SHEET is a real read_sheet_values result (Rick's existing sheet,
// range A1:I5). CREATE_SHEET is a real create_spreadsheet result (temp sheet,
// trashed after capture).
//
// Notes measured against the live server:
// - search: "Message ID:" and "Web Link:" lines are indented; the page token
//   is printed in single quotes: page_token='<token>'.
// - batch: blocks are separated by a line with just "---"; the per-message
//   link is "Web Link:" (NOT "URL:"); List-Unsubscribe is printed when
//   present, with the raw header value (here an https link only, no mailto).
// - read_sheet_values: one line per row: the sheet row number, then the row's
//   cells separated by tabs. The range is clamped to at most 1000 rows.
// - modify_sheet_values: range_name is the top-left cell only; values must be
//   an array of arrays of STRINGS (a JS number in values fails the schema);
//   value_input_option "RAW" writes the string as the cell value.

export const SEARCH_PAGE = `
Found 15 messages matching 'after:2026-11-24 before:2026-11-25 -in:sent -in:drafts -in:chats':

📧 MESSAGES:
  1. Message ID: 1a20ff91ecf7612b
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff91ecf7612b
     Thread ID: 1a20ff91ecf7612b
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff91ecf7612b

  2. Message ID: 1a20ff5f9a2ded06
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff5f9a2ded06
     Thread ID: 1a20ff5f9a2ded06
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff5f9a2ded06

  3. Message ID: 1a20ff047f21479c
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff047f21479c
     Thread ID: 1a20ff047f21479c
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff047f21479c

  4. Message ID: 1a20ff037bd45ee5
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff037bd45ee5
     Thread ID: 1a20ff037bd45ee5
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff037bd45ee5

  5. Message ID: 1a20fed758783781
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fed758783781
     Thread ID: 1a20fed758783781
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fed758783781

  6. Message ID: 1a20fe6a79afc962
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fe6a79afc962
     Thread ID: 1a20fe6a79afc962
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fe6a79afc962

  7. Message ID: 1a20fe5f97db72ad
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fe5f97db72ad
     Thread ID: 1a20fe5f97db72ad
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fe5f97db72ad

  8. Message ID: 1a20fcdad6786a6b
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fcdad6786a6b
     Thread ID: 1a20fcdad6786a6b
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fcdad6786a6b

  9. Message ID: 1a20fcc8d6513f79
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fcc8d6513f79
     Thread ID: 1a20fcc8d6513f79
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fcc8d6513f79

  10. Message ID: 1a20fc905c1370cc
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fc905c1370cc
     Thread ID: 1a20fc905c1370cc
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fc905c1370cc

  11. Message ID: 1a20fb49210909b5
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fb49210909b5
     Thread ID: 1a20fb49210909b5
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fb49210909b5

  12. Message ID: 1a20faf89588b317
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20faf89588b317
     Thread ID: 1a20faf89588b317
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20faf89588b317

  13. Message ID: 1a20fac9dabeabb9
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fac9dabeabb9
     Thread ID: 1a20fac9dabeabb9
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fac9dabeabb9

  14. Message ID: 1a20fa5fc7db8903
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa5fc7db8903
     Thread ID: 1a20fa5fc7db8903
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa5fc7db8903

  15. Message ID: 1a20fa4baf6d2f75
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4baf6d2f75
     Thread ID: 1a20fa4baf6d2f75
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4baf6d2f75

💡 USAGE:
  • Pass the Message IDs **as a list** to get_gmail_messages_content_batch()
    e.g. get_gmail_messages_content_batch(message_ids=[...])
  • Pass the Thread IDs to get_gmail_thread_content() (single) or get_gmail_threads_content_batch() (batch)

📄 PAGINATION: To get the next page, call search_gmail_messages again with page_token='13399976901664959792'
`;

export const LAST_PAGE = `
Found 3 messages matching 'after:2026-11-24 before:2026-11-25 -in:sent -in:drafts -in:chats':

📧 MESSAGES:
  1. Message ID: 1a20fa4baf6d2f75
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4baf6d2f75
     Thread ID: 1a20fa4baf6d2f75
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4baf6d2f75

  2. Message ID: 1a20fa4b00000001
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4b00000001
     Thread ID: 1a20fa4b00000001
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4b00000001

  3. Message ID: 1a20fa4b00000002
     Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4b00000002
     Thread ID: 1a20fa4b00000002
     Thread Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fa4b00000002

💡 USAGE:
  • Pass the Message IDs **as a list** to get_gmail_messages_content_batch()
    e.g. get_gmail_messages_content_batch(message_ids=[...])
  • Pass the Thread IDs to get_gmail_thread_content() (single) or get_gmail_threads_content_batch() (batch)
`;

export const EMPTY_PAGE = `
Found 0 messages matching 'after:2026-11-24 before:2026-11-25 -in:sent -in:drafts -in:chats':

📧 MESSAGES:

💡 USAGE:
  • Pass the Message IDs **as a list** to get_gmail_messages_content_batch()
    e.g. get_gmail_messages_content_batch(message_ids=[...])
  • Pass the Thread IDs to get_gmail_thread_content() (single) or get_gmail_threads_content_batch() (batch)
`;

export const METADATA = `
Retrieved 5 messages:

Message ID: 1a20ff91ecf7612b
Subject: A surprise waiting for you
From: AliExpress <ae-editor-pick04@selections.aliexpress.com>
Date: Wed, 25 Nov 2026 07:51:52 +0800 (CST)
Message-ID: <923217959.145054853.1795564312196@global-message-center-receiver215066229153.os30>
To: rick@theashfords.org
Cc: [not present in Gmail response]
Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff91ecf7612b

---

Message ID: 1a20ff5f9a2ded06
Subject: 👁️ Americans’ trust in elections rebounds + DOJ says 800+ charged in scams that sought $8B
From: Ground News <blindspot@ground-news.com>
Date: Tue, 24 Nov 2026 23:48:27 +0000
Reply-To: feedback@ground.news
Message-ID: <010101a20ff5f58f-d2d8f8e3-4228-4537-b0c1-16dd66decf13-000000@us-west-2.amazonses.com>
To: rick@theashfords.org
Cc: [not present in Gmail response]
Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff5f9a2ded06

---

Message ID: 1a20ff047f21479c
Subject: Alcohol delivery reminders
From: Amazon Flex <no-reply@flex.amazon.com>
Date: Tue, 24 Nov 2026 23:42:13 +0000
Reply-To: amazonflex@amazon.com
Message-ID: <010001a20ff04395-68382127-eed8-41d6-9115-9614173faee1-000000@email.amazonses.com>
To: rick@theashfords.org
Cc: [not present in Gmail response]
Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff047f21479c

---

Message ID: 1a20ff037bd45ee5
Subject: [Flickr] New items from the people you follow
From: Flickr Mail <flickrteam@arrow.flickr.com>
Date: Tue, 24 Nov 2026 23:42:09 +0000
Reply-To: noreply@flickr.com
Message-ID: <0C.2E.22115.1D0260B6@i-00a545066c0d4f1fb.mta1vrest.sd.prd.sparkpost>
To: rick@theashfords.org
Cc: [not present in Gmail response]
Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff037bd45ee5

---

Message ID: 1a20fed758783781
Subject: Thanksgiving place cards for your table 🧡
From: Ben - Talking Point Cards <support@talkingpointcards.com>
Date: Tue, 24 Nov 2026 23:39:08 +0000 (UTC)
Message-ID: <Ht_cmvZpTm2G1QTNQLM3Mg@geopod-ismtpd-108>
To: Rick Ashford <rick@theashfords.org>
Cc: [not present in Gmail response]
List-Unsubscribe: <https://manage.kmail-lists.com/subscriptions/unsubscribe?a=TeeNC8&c=01GR2VM6Z42B6K2S10KATFMFM9&k=1c9269c181d600a8b79a69064e960ff2&st=gAAAAABrBiAP-zulMrJYR0CYnhgvB1x1zjS5C5I3xCIhVbyx9ypNUU5Erai2v9AVlqxnZ2lU7_pCziEG-PcNjxhYP5WHj3uXzwpsM3m5GKsNEfeD0KDza6s%3D&m=01M87R18Q1J1X1XMW8XANFPT5P&r=01M87YT6HRCEHFVD3MHP3707SV>
Web Link: https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fed758783781
`;

export const READ_SHEET = "Successfully read 5 rows from range 'A1:I5' in spreadsheet 14hg_5Ac6y4zH02LypeC68qO_tD47cTizXRIETy_iL-s for rick@theashfords.org:\nEach line: sheet row number, then tab-separated cells from column A.\n1\tMailing list\tFrom address\tWhat it is\tLatest seen\n2\tLinkedIn Job Alerts\tjobalerts-noreply@linkedin.com\tJob match alerts\t2026-11-04\n3\tLinkedIn News\teditors-noreply@linkedin.com\tNews roundups\t2026-10-30\n4\tLinkedIn Messages\tmessages-noreply@linkedin.com\tConnection / activity nudges\t2026-11-02\n5\tLinkedIn Notifications\tnotifications-noreply@linkedin.com\tPost impression summaries\t2026-11-02";

export const CREATE_SHEET = "Successfully created spreadsheet 'gwen mail-census test sheet (delete me)' for rick@theashfords.org. ID: 14d-oozhS6zDNpW8FNphvtnzUzihjjArFhvfq4ZPobgk | URL: https://docs.google.com/spreadsheets/d/14d-oozhS6zDNpW8FNphvtnzUzihjjArFhvfq4ZPobgk/edit?ouid=103948246537730958211 | Locale: en_US";
