# Migrations en attente

`0018_remove_srt_library.sql` efface définitivement les tables `srt_*`. Elle attend l’accord explicite de l’utilisateur ;
une fois validée, la remettre dans `migrations/` sous un numéro supérieur au dernier appliqué, sauvegarder la base, puis l’appliquer.
