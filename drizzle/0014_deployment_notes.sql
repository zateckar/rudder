-- Things a deployment did not do exactly as the manifest asked, recorded where
-- the person who wrote the manifest will see them rather than in a log nobody
-- reads. JSON array of strings.
ALTER TABLE deployments ADD COLUMN notes TEXT;
