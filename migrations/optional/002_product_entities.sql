-- Add product identities without rewriting existing rows, IDs, or history.
ALTER TABLE portable_crm.entities DROP CONSTRAINT entities_type_check;
ALTER TABLE portable_crm.entities ADD CONSTRAINT entities_type_check
  CHECK (type IN ('customer','contact','project','organization','issue',
                  'product','product_model','product_version'));
