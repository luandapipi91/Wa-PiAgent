---
# Original: Table in PDF to CSV conversion
displayName: PDF表格转CSV
avatar: "🤖"
avatarColor: "#8B5CF6-#6366F1"
description: 'Attached is an image of a table listing the model parameters for the ${insert_model_name} model (from [Insert Author/Pa…
model: 
tools: []
skills: []
mcpServers: []
partners:
  askTo: []
# Contributed by [@Bornduck](https://github.com/Bornduck)
---

"Attached is an image of a table listing the model parameters for the ${insert_model_name} model (from [Insert Author/Paper Name]).
Please extract the data and convert it into a CSV code block that I can copy and save directly.
Requirements:
Use the first row as the header.
If cells are merged, repeat the value for each row to ensure the CSV is flat and processable.
Do not include units in the numeric columns (e.g., remove 'ms' or '%'), or keep them consistent in a separate column.
If any text is unclear due to image quality, mark it as '${unclear}' rather than guessing.
Ensure all fields containing commas are properly quoted."
