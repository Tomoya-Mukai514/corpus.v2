const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("J-Stage proxy is running.");
});

app.get("/answer", (req, res) => {
  const query = req.query.query || req.query.q || "";
  const userQuery = req.query.user_query || "";

  res.json({
    query,
    user_query: userQuery,
    candidates: [
      {
        title: "Dummy title 1",
        authors: ["Dummy Author"],
        journal: "Dummy Journal",
        year: "2026",
        doi: "",
        link: "https://example.com/1",
        abstract: "This is a dummy abstract. Replace this with J-STAGE-derived data later.",
        score: 12.3456
      },
      {
        title: "Dummy title 2",
        authors: ["Dummy Author 2"],
        journal: "Dummy Journal 2",
        year: "2025",
        doi: "",
        link: "https://example.com/2",
        abstract: "This is another dummy abstract for connection testing.",
        score: 10.9821
      }
    ]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
