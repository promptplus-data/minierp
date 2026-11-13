-- Salary account split into bank (Bank of Thailand code), account number and account name.
-- Existing free text "กสิกร 012-3-45678-9" is split when it starts with a known bank name; otherwise it stays as the number.
ALTER TABLE employees ADD COLUMN bank text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN bank_account_name text NOT NULL DEFAULT '';

-- Row-level security is forced even for the owner, so the split runs once per shop with that shop's tenant set.
DO $mig$
DECLARE t uuid;
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    WITH names(code, pat) AS (VALUES
      ('BBL', '^(ธนาคาร|ธ\.)?\s*กรุงเทพ'), ('KBANK', '^(ธนาคาร|ธ\.)?\s*กสิกร(ไทย)?'), ('KTB', '^(ธนาคาร|ธ\.)?\s*กรุงไทย'),
      ('SCB', '^(ธนาคาร|ธ\.)?\s*ไทยพาณิชย์'), ('BAY', '^(ธนาคาร|ธ\.)?\s*กรุงศรี(อยุธยา)?'), ('TTB', '^(ธนาคาร|ธ\.)?\s*(ทหารไทยธนชาต|ทหารไทย|ธนชาต|ttb|ทีทีบี)'),
      ('GSB', '^(ธนาคาร|ธ\.)?\s*ออมสิน'), ('BAAC', '^(ธ\.ก\.ส\.|ธกส)'), ('GHB', '^(ธนาคาร|ธ\.)?\s*(อาคารสงเคราะห์|ธอส\.?)'),
      ('UOB', '^(ธนาคาร|ธ\.)?\s*(ยูโอบี|uob)'), ('CIMB', '^(ธนาคาร|ธ\.)?\s*(ซีไอเอ็มบี|cimb)(\s*ไทย)?'), ('KKP', '^(ธนาคาร|ธ\.)?\s*เกียรตินาคิน(ภัทร)?'),
      ('TISCO', '^(ธนาคาร|ธ\.)?\s*(ทิสโก้|tisco)'), ('LHB', '^(ธนาคาร|ธ\.)?\s*แลนด์\s*แอนด์\s*เฮ้าส์'), ('ICBC', '^(ธนาคาร|ธ\.)?\s*(ไอซีบีซี|icbc)'),
      ('IBANK', '^(ธนาคาร|ธ\.)?\s*อิสลาม')
    )
    UPDATE employees e SET bank = n.code, bank_account = btrim(regexp_replace(e.bank_account, n.pat, '', 'i'))
    FROM names n
    WHERE e.bank = '' AND e.bank_account ~* n.pat;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.auth_lookup', 'off', true);
END
$mig$;
