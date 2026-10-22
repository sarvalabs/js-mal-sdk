[coco]
version = "0.9.3"

[module]
name = "AuthorityRegistry"
version = "1.0.0"
license = ["MIT", "Apache-2.0"]
repository = "https://github.com/sarvalabs/js-mal-sdk"
authors = ["Gokul <gokulramalingam1@gmail.com>"]

[target]
os = "MOI"
arch = "PISA"

[target.moi]
format = "YAML"
output = "authority_registry"

[target.pisa]
format = "ASM"
version = "0.8.0"
