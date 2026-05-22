-- Up Migration
-- Insert the owner contact based on configured OWNER_EMAIL.
-- We don't have access to env vars in raw SQL, so we use a sentinel and
-- let scripts/seed.ts overwrite it during boot.
INSERT INTO contacts (id, email, display_name, trust_level)
VALUES ('00000000000000000000000000', 'owner@placeholder.invalid', 'Owner Placeholder', 'self')
ON CONFLICT (email) DO NOTHING;
