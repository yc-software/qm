UPDATE participants
SET color = CASE lower(color)
  WHEN '#ef4444' THEN '#f43f5e'
  WHEN '#22c55e' THEN '#10b981'
  WHEN '#a855f7' THEN '#8b5cf6'
END
WHERE lower(color) IN ('#ef4444', '#22c55e', '#a855f7');
