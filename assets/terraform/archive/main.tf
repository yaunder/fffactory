# The factory's log archive bucket, for a factory.json enabling `log_archive`. Like backend/,
# this root keeps no state: each plan starts empty, so it can only create the bucket, and
# nothing destroys it. Nothing plans it yet; apply creates the missing archive from #113.
#
# TODO(re-evaluate when retention or bucket settings must change): without state, an existing
# archive cannot be reconfigured, only created. Changing its settings needs the bucket imported
# into a plan, or a root that keeps state outside the factory's state bucket.

module "log_archive" {
  source = "../modules/log-archive"

  factory_id    = var.factory_id
  bucket_suffix = var.archive_bucket_suffix
}
