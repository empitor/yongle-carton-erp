-- 追加在 v0.6.1 基线上。v0.6.1 尚无收件箱和唛头，使用实际第 14、15 版结构。
CREATE TABLE inbox_items(
        id INTEGER PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL,
        sender_id TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '',
        conversation TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
        file_name TEXT, file_mime TEXT, file_size INTEGER, file_sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'pending', converted_kind TEXT, converted_ref TEXT,
        handled_by TEXT, handled_at TEXT, version INTEGER NOT NULL DEFAULT 1,
        received_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(channel,external_id));
        CREATE INDEX inbox_status_received ON inbox_items(status,received_at);
        CREATE TABLE inbox_files(sha256 TEXT PRIMARY KEY,content BLOB NOT NULL,size INTEGER NOT NULL);
        INSERT INTO schema_migrations VALUES(14,datetime('now'));
CREATE TABLE mark_files(sha256 TEXT PRIMARY KEY,content BLOB NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,file_name TEXT NOT NULL);
        CREATE TABLE product_marks(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),file_sha256 TEXT NOT NULL REFERENCES mark_files(sha256),page INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL DEFAULT '',fields TEXT NOT NULL,source_kind TEXT NOT NULL,source_ref TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(product_id,file_sha256,page));
        CREATE INDEX product_marks_product ON product_marks(product_id);
        INSERT INTO schema_migrations VALUES(15,datetime('now'));
INSERT INTO inbox_files VALUES('6651b3c2df445ed87e6ae78df7fab9cb835244c3e87958fe7e0bcf5ef8b486f6',X'45525000',4);
INSERT INTO inbox_items(id,channel,external_id,kind,text,file_name,file_sha256,file_size,received_at,created_at,version)
VALUES(1,'manual','fictional-old-inbox','file','虚构历史收件','fictional.bin','6651b3c2df445ed87e6ae78df7fab9cb835244c3e87958fe7e0bcf5ef8b486f6',4,'2026-10-23','2026-10-23',2);
INSERT INTO mark_files VALUES('13f331e68fcf00529c26a536eecbeb494d961b5674af3447577a97c2ca42ec49',X'89504E470D0A1A0A0000000D4948445200000001000000010804000000B51C0C020000000B4944415478DA63FCFF1F0003030200EFA3832B0000000049454E44AE426082',68,'image/png','fictional.png');
INSERT INTO product_marks(id,product_id,file_sha256,title,fields,source_kind,created_by,created_at,updated_at,version)
VALUES(1,1,'13f331e68fcf00529c26a536eecbeb494d961b5674af3447577a97c2ca42ec49','虚构历史唛头','{}','manual','test-operator','2026-10-23','2026-10-23',3);
